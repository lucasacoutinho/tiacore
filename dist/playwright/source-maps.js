import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AnyMap, eachMapping, } from '@jridgewell/trace-mapping';
import { projectRelative } from '../shared/paths.js';
const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024;
const SOURCE_MAP_SUFFIX = /(?:\.bundle|\.m?js)$/i;
const sourceMapCache = new Map();
const textCache = new Map();
function mappedSources(map) {
    return [
        ...(map.sources ?? []).map((source) => map.sourceRoot === undefined
            ? source
            : `${map.sourceRoot.replace(/\/+$/, '')}/${source.replace(/^\/+/, '')}`),
        ...(map.sections ?? []).flatMap((section) => section.map === undefined ? [] : mappedSources(section.map)),
    ];
}
function decodedDataUrl(value) {
    const match = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(value);
    if (match === null) {
        return null;
    }
    try {
        return match[1] === undefined
            ? decodeURIComponent(match[2])
            : Buffer.from(match[2], 'base64').toString('utf8');
    }
    catch {
        return null;
    }
}
async function uncachedBoundedText(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            return null;
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_SOURCE_MAP_BYTES) {
            return null;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytes.byteLength > MAX_SOURCE_MAP_BYTES
            ? null
            : Buffer.from(bytes).toString('utf8');
    }
    catch {
        return null;
    }
}
function boundedText(url) {
    const cached = textCache.get(url);
    if (cached !== undefined) {
        return cached;
    }
    const pending = uncachedBoundedText(url);
    textCache.set(url, pending);
    return pending;
}
function sourceMapUrl(scriptUrl, script) {
    const directive = /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^*]+)\*\/)\s*$/.exec(script);
    const value = directive?.[1] ?? directive?.[2]?.trim();
    if (value !== undefined) {
        return value.startsWith('data:')
            ? value
            : new URL(value, scriptUrl).href;
    }
    const url = new URL(scriptUrl);
    if (!SOURCE_MAP_SUFFIX.test(url.pathname)) {
        return null;
    }
    url.pathname = url.pathname.replace(SOURCE_MAP_SUFFIX, '.map');
    return url.href;
}
function sourcePath(root, value, baseUrl) {
    let candidate = value;
    let filesystemUrl = false;
    try {
        if (value.startsWith('file:')) {
            candidate = fileURLToPath(value);
            filesystemUrl = true;
        }
        else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
            const url = new URL(value);
            if (url.protocol !== 'webpack:' && url.protocol !== 'vite:') {
                return null;
            }
            candidate = decodeURIComponent(url.pathname);
        }
    }
    catch {
        return null;
    }
    candidate = candidate
        .replace(/^webpack:\/\/\/?/, '')
        .replace(/^vite:\/\/\/?/, '')
        .replace(/^\/@fs\//, '/')
        .replace(/[?#].*$/, '');
    const paths = filesystemUrl
        ? [resolve(candidate)]
        : [
            ...(candidate.startsWith('/') ? [resolve(candidate)] : []),
            resolve(root, candidate.replace(/^[/\\]+/, '')),
            ...(baseUrl === undefined
                ? []
                : [
                    resolve(root, dirname(new URL(baseUrl).pathname).replace(/^[/\\]+/, ''), candidate),
                ]),
        ];
    for (const absolute of paths) {
        const relative = projectRelative(root, absolute);
        if (relative !== null &&
            relative !== '' &&
            existsSync(absolute)) {
            return relative;
        }
    }
    return null;
}
async function uncachedSourceMapFiles(scriptUrl, root) {
    const direct = sourcePath(root, new URL(scriptUrl).pathname);
    let script = '';
    let mapUrl = sourceMapUrl(scriptUrl, script);
    if (mapUrl === null || !scriptUrl.includes('.bundle')) {
        script = (await boundedText(scriptUrl)) ?? '';
        mapUrl = sourceMapUrl(scriptUrl, script);
    }
    if (mapUrl === null) {
        return direct === null ? [] : [direct];
    }
    const source = decodedDataUrl(mapUrl) ??
        await boundedText(mapUrl);
    if (source === null) {
        return direct === null ? [] : [direct];
    }
    try {
        const map = JSON.parse(source);
        const sourceBase = mapUrl.startsWith('data:') ? scriptUrl : mapUrl;
        return [
            ...new Set([
                ...(direct === null ? [] : [direct]),
                ...mappedSources(map)
                    .map((file) => sourcePath(root, file, sourceBase))
                    .filter((file) => file !== null),
            ]),
        ].sort();
    }
    catch {
        return direct === null ? [] : [direct];
    }
}
function lineOffsets(source) {
    const offsets = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source.charCodeAt(index) === 10) {
            offsets.push(index + 1);
        }
    }
    return offsets;
}
function coverageRanges(functions) {
    return functions
        .flatMap((item) => item.ranges)
        .filter((range) => range.startOffset >= 0 &&
        range.endOffset > range.startOffset)
        .map((range) => ({
        count: range.count,
        end: range.endOffset,
        length: range.endOffset - range.startOffset,
        start: range.startOffset,
    }))
        .sort((left, right) => left.start - right.start ||
        left.length - right.length ||
        left.count - right.count);
}
function executedMappedSources(map, script, functions) {
    const ranges = coverageRanges(functions);
    if (ranges.length === 0) {
        return [];
    }
    const offsets = lineOffsets(script);
    const files = new Set();
    const active = [];
    let rangeIndex = 0;
    eachMapping(new AnyMap(map), (mapping) => {
        if (mapping.source === null) {
            return;
        }
        const lineStart = offsets[mapping.generatedLine - 1];
        if (lineStart === undefined) {
            return;
        }
        const offset = lineStart + mapping.generatedColumn;
        while (rangeIndex < ranges.length &&
            ranges[rangeIndex].start <= offset) {
            active.push(ranges[rangeIndex]);
            rangeIndex += 1;
        }
        let selected = null;
        for (let index = active.length - 1; index >= 0; index -= 1) {
            const range = active[index];
            if (range.end <= offset) {
                active.splice(index, 1);
                continue;
            }
            if (selected === null ||
                range.length < selected.length ||
                (range.length === selected.length &&
                    range.count < selected.count)) {
                selected = range;
            }
        }
        if (selected !== null && selected.count > 0) {
            files.add(mapping.source);
        }
    });
    return [...files];
}
export async function coveredSourceMapFiles(scriptUrl, suppliedScript, functions, root) {
    const script = suppliedScript ?? await boundedText(scriptUrl);
    if (script === null) {
        return [];
    }
    const direct = sourcePath(root, new URL(scriptUrl).pathname);
    const hasExecutedRange = functions.some((item) => item.ranges.some((range) => range.count > 0));
    const mapUrl = sourceMapUrl(scriptUrl, script);
    if (mapUrl === null) {
        return direct !== null && hasExecutedRange ? [direct] : [];
    }
    const source = decodedDataUrl(mapUrl) ??
        await boundedText(mapUrl);
    if (source === null) {
        return direct !== null && hasExecutedRange ? [direct] : [];
    }
    try {
        const map = JSON.parse(source);
        const sourceBase = mapUrl.startsWith('data:') ? scriptUrl : mapUrl;
        return [
            ...new Set([
                ...(direct !== null && hasExecutedRange ? [direct] : []),
                ...executedMappedSources(map, script, functions)
                    .map((file) => sourcePath(root, file, sourceBase))
                    .filter((file) => file !== null),
            ]),
        ].sort();
    }
    catch {
        return direct !== null && hasExecutedRange ? [direct] : [];
    }
}
export function sourceMapFiles(scriptUrl, root) {
    const key = `${root}\0${scriptUrl}`;
    const cached = sourceMapCache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const pending = uncachedSourceMapFiles(scriptUrl, root);
    sourceMapCache.set(key, pending);
    return pending;
}
//# sourceMappingURL=source-maps.js.map