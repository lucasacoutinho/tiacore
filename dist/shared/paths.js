import { posix, win32 } from 'node:path';
function windowsPath(value) {
    return (/^[a-z]:[\\/]/i.test(value) ||
        /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value));
}
function pathApi(...values) {
    if (values.some(windowsPath)) {
        return win32;
    }
    if (values.some((value) => value.startsWith('/'))) {
        return posix;
    }
    return process.platform === 'win32' ? win32 : posix;
}
export function slash(path) {
    return path.replaceAll('\\', '/');
}
export function projectRelative(root, path) {
    const api = pathApi(root, path);
    const candidate = slash(api.relative(root, path));
    if (candidate === '' || candidate === '.') {
        return '';
    }
    if (candidate === '..' ||
        candidate.startsWith('../') ||
        api.isAbsolute(candidate)) {
        return null;
    }
    return candidate;
}
export function resolveCacheDir(root, cacheDir) {
    const api = pathApi(root, cacheDir);
    return api.isAbsolute(cacheDir)
        ? api.normalize(cacheDir)
        : api.resolve(root, cacheDir);
}
export function isInside(parent, child) {
    const api = pathApi(parent, child);
    const rel = api.relative(parent, child);
    return (rel !== '..' &&
        !rel.startsWith(`..${api.sep}`) &&
        !api.isAbsolute(rel));
}
//# sourceMappingURL=paths.js.map