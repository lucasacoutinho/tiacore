import { existsSync, readFileSync, } from 'node:fs';
import { dirname, extname, resolve, } from 'node:path';
import { hashBytes, hashFile } from '../graph/fingerprint.js';
import { projectRelative } from '../shared/paths.js';
const IMPORT_PATTERN = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const EXTENSIONS = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.json',
];
function importedSpecifiers(source) {
    return [...source.matchAll(IMPORT_PATTERN)]
        .map((match) => match[1] ?? match[2])
        .filter((specifier) => specifier !== undefined && specifier.startsWith('.'));
}
function resolveImport(importer, specifier) {
    const candidate = resolve(dirname(importer), specifier);
    const paths = extname(candidate) === ''
        ? [
            candidate,
            ...EXTENSIONS.map((extension) => `${candidate}${extension}`),
            ...EXTENSIONS.map((extension) => resolve(candidate, `index${extension}`)),
        ]
        : [candidate];
    return paths.find((path) => existsSync(path)) ?? null;
}
export function importedProjectFiles(entry, root) {
    const pending = [resolve(entry)];
    const visited = new Set();
    const files = new Set();
    while (pending.length > 0) {
        const file = pending.pop();
        if (file === undefined || visited.has(file)) {
            continue;
        }
        visited.add(file);
        const relative = projectRelative(root, file);
        if (relative === null || relative === '') {
            continue;
        }
        files.add(relative);
        let source;
        try {
            source = readFileSync(file, 'utf8');
        }
        catch {
            continue;
        }
        for (const specifier of importedSpecifiers(source)) {
            const imported = resolveImport(file, specifier);
            if (imported !== null) {
                pending.push(imported);
            }
        }
    }
    return [...files].sort();
}
export function importedFilesFingerprint(entry, root) {
    return hashBytes(JSON.stringify(importedProjectFiles(entry, root).map((file) => [
        file,
        hashFile(resolve(root, file)),
    ])));
}
//# sourceMappingURL=imports.js.map