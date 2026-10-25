import { posix, win32 } from 'node:path'

// The 1.x project-relative path rule, shared by the framework edges and the
// coverage selection. It keeps absolute and Windows paths working on any host,
// which `normalizePath` (project-relative input only) does not.

type PathApi = typeof posix

function windowsPath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/iu.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value)
  )
}

function pathApi(...values: string[]): PathApi {
  if (values.some(windowsPath)) return win32
  if (values.some((value) => value.startsWith('/'))) return posix
  return process.platform === 'win32' ? win32 : posix
}

/** Replaces every backslash with a slash. */
export function slash(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * Returns `path` relative to `root` with `/` separators, `''` for the root
 * itself, and null when the path lies outside the root.
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
