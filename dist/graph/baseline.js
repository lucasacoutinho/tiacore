import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, } from 'node:fs';
import { resolve } from 'node:path';
import picomatch from 'picomatch';
import { slash } from '../shared/paths.js';
import { hashFile } from './fingerprint.js';
const ALWAYS_IGNORED_DIRECTORIES = new Set([
    '.git',
    '.tia',
    'node_modules',
]);
const ROOT_OUTPUT_DIRECTORIES = new Set([
    '.cache',
    '.turbo',
    'build',
    'coverage',
    'dist',
]);
const VITE_TEMPORARY_CONFIG = /\.config\.[cm]?[jt]s\.timestamp-\d+-[a-z\d]+\.mjs$/i;
function runGit(root, args) {
    try {
        return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
            cwd: root,
            maxBuffer: 20 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    }
    catch {
        return null;
    }
}
function gitText(root, args) {
    const value = runGit(root, args);
    return value === null ? null : value.toString('utf8').trim();
}
function gitPaths(root, args) {
    const value = runGit(root, args);
    if (value === null) {
        return null;
    }
    return value
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map(slash);
}
export function currentSha(root) {
    return gitText(root, ['rev-parse', '--verify', 'HEAD']);
}
export function isAncestor(root, ancestor, descendant) {
    return runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}
function untrackedFiles(root) {
    return gitPaths(root, ['ls-files', '-z', '--others', '--exclude-standard']);
}
function filesDifferentFrom(root, revision) {
    return gitPaths(root, [
        'diff',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACDMRTUXB',
        '-z',
        revision,
        '--',
    ]);
}
function unique(paths) {
    return [...new Set(paths)].sort();
}
function isIgnored(file, prefixes) {
    return (Array.isArray(prefixes) ? prefixes : [prefixes]).some((prefix) => prefix !== '' &&
        (file === prefix || file.startsWith(`${prefix}/`)));
}
function ignoreRules(root) {
    try {
        return readFileSync(resolve(root, '.gitignore'), 'utf8')
            .split(/\r?\n/)
            .flatMap((line) => {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) {
                return [];
            }
            const ignored = !trimmed.startsWith('!');
            const original = ignored ? trimmed : trimmed.slice(1);
            const anchored = original.startsWith('/');
            const directory = original.endsWith('/');
            const pattern = original
                .replace(/^\/+/, '')
                .replace(/\/+$/, '');
            if (pattern === '') {
                return [];
            }
            const variants = anchored || pattern.includes('/')
                ? [pattern]
                : [pattern, `**/${pattern}`];
            if (directory) {
                variants.push(`${pattern}/**`, ...(anchored || pattern.includes('/')
                    ? []
                    : [`**/${pattern}/**`]));
            }
            return [{
                    ignored,
                    matcher: picomatch(variants, { dot: true }),
                }];
        });
    }
    catch {
        return [];
    }
}
function ignoredByRules(file, rules) {
    let ignored = false;
    for (const rule of rules) {
        if (rule.matcher(file)) {
            ignored = rule.ignored;
        }
    }
    return ignored;
}
function walkProjectFiles(root, ignoredPrefixes) {
    const files = [];
    const rules = ignoreRules(root);
    function visit(directory, prefix) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (isIgnored(file, ignoredPrefixes)) {
                continue;
            }
            if (entry.isDirectory()) {
                if (ALWAYS_IGNORED_DIRECTORIES.has(entry.name) ||
                    (prefix === '' && ROOT_OUTPUT_DIRECTORIES.has(entry.name)) ||
                    ignoredByRules(file, rules)) {
                    continue;
                }
                visit(resolve(directory, entry.name), file);
            }
            else if (entry.isFile() && !ignoredByRules(file, rules)) {
                files.push(slash(file));
            }
        }
    }
    try {
        visit(root, '');
        return unique(files);
    }
    catch {
        return null;
    }
}
function projectFiles(root, ignoredPrefixes) {
    const listed = gitPaths(root, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
    ]);
    return listed === null
        ? walkProjectFiles(root, ignoredPrefixes)?.filter((file) => !VITE_TEMPORARY_CONFIG.test(file)) ?? null
        : unique(listed).filter((file) => !isIgnored(file, ignoredPrefixes) &&
            !VITE_TEMPORARY_CONFIG.test(file));
}
function filesystemChanges(root, baseline, ignoredPrefixes) {
    const current = projectFiles(root, ignoredPrefixes);
    if (current === null) {
        return null;
    }
    const candidates = unique([
        ...Object.keys(baseline.workingTree),
        ...current,
    ]);
    const currentFiles = new Set(current);
    return candidates.filter((file) => {
        const hash = currentFiles.has(file)
            ? hashFile(resolve(root, file))
            : null;
        return baseline.workingTree[file] !== hash;
    });
}
export function changedFilesSince(root, baseline, ignoredPrefixes) {
    if (baseline.source === 'filesystem') {
        return filesystemChanges(root, baseline, ignoredPrefixes);
    }
    const head = currentSha(root);
    if (head === null || !isAncestor(root, baseline.sha, head)) {
        return null;
    }
    const tracked = filesDifferentFrom(root, baseline.sha);
    const untracked = untrackedFiles(root);
    if (tracked === null || untracked === null) {
        return null;
    }
    return unique([...tracked, ...untracked])
        .filter((file) => !isIgnored(file, ignoredPrefixes))
        .filter((file) => !VITE_TEMPORARY_CONFIG.test(file))
        .filter((file) => baseline.workingTree[file] !== hashFile(resolve(root, file)));
}
export function captureBaseline(root, ignoredPrefixes) {
    const sha = currentSha(root);
    if (sha === null) {
        const files = projectFiles(root, ignoredPrefixes);
        if (files === null) {
            return null;
        }
        return {
            sha: '',
            source: 'filesystem',
            workingTree: Object.fromEntries(files.map((file) => [
                file,
                hashFile(resolve(root, file)),
            ])),
        };
    }
    const tracked = filesDifferentFrom(root, sha);
    const untracked = untrackedFiles(root);
    if (tracked === null || untracked === null) {
        return null;
    }
    const workingTree = {};
    for (const file of unique([...tracked, ...untracked])) {
        if (isIgnored(file, ignoredPrefixes)) {
            continue;
        }
        const absolute = resolve(root, file);
        if (existsSync(absolute) || tracked.includes(file)) {
            workingTree[file] = hashFile(absolute);
        }
    }
    return { sha, source: 'git', workingTree };
}
//# sourceMappingURL=baseline.js.map