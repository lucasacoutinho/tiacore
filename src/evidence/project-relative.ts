import { posix, win32 } from 'node:path'

// The evidence SDK imports nothing from the rest of tiacore, so it carries its
// own copy of the 1.x project-relative path rule.

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

/**
 * Returns `path` relative to `root` with `/` separators, `''` for the root
 * itself, and null when the path lies outside the root.
 */
export function projectRelative(root: string, path: string): string | null {
  const api = pathApi(root, path)
  const candidate = api.relative(root, path).replaceAll('\\', '/')
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
