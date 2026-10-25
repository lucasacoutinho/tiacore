import { posix, win32 } from 'node:path'

// Host path helpers. A path that names a Windows drive or UNC share is handled
// with win32 rules on every platform, so cache and containment decisions made
// on a POSIX CI runner about a Windows path never leak the host's rules.

type PathApi = typeof posix

function windowsPath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/iu.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value)
  )
}

function pathApi(...values: readonly string[]): PathApi {
  if (values.some(windowsPath)) return win32
  if (values.some((value) => value.startsWith('/'))) return posix
  return process.platform === 'win32' ? win32 : posix
}

/** Replaces every backslash with a forward slash, on every platform. */
export function slash(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * The root-relative path with `/` separators, `''` for the root itself, and
 * null when `path` is outside `root` (including another drive or UNC share).
 */
export function projectRelative(root: string, path: string): string | null {
  const api = pathApi(root, path)
  const candidate = slash(api.relative(root, path))
  if (candidate === '' || candidate === '.') return ''
  if (
    candidate === '..' ||
    candidate.startsWith('../') ||
    api.isAbsolute(candidate)
  ) {
    return null
  }
  return candidate
}

/**
 * The root-relative path of a file below `root`, with `/` separators. Null for
 * a path outside `root` and for `root` itself, neither of which names a file.
 */
export function projectFile(root: string, path: string): string | null {
  const relative = projectRelative(root, path)
  return relative === '' ? null : relative
}

/** Normalizes an absolute cache directory and resolves a relative one against root. */
export function resolveCacheDir(root: string, cacheDir: string): string {
  const api = pathApi(root, cacheDir)
  return api.isAbsolute(cacheDir)
    ? api.normalize(cacheDir)
    : api.resolve(root, cacheDir)
}

/** True for the same path and its descendants; false for `..` escapes and sibling prefixes. */
export function isInside(parent: string, child: string): boolean {
  const api = pathApi(parent, child)
  const relative = api.relative(parent, child)
  return (
    relative !== '..' &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  )
}
