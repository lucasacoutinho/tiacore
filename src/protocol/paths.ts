import { posix } from 'node:path'

const URI_PATTERN = /^[a-z][a-z0-9+.-]*:/iu
const WINDOWS_ABSOLUTE_PATTERN = /^[a-z]:\//iu

export function normalizeProtocolPath(value: string): string {
  const slashed = value.replaceAll('\\', '/')
  if (URI_PATTERN.test(slashed) && !WINDOWS_ABSOLUTE_PATTERN.test(slashed)) {
    return slashed
  }

  const withoutDot = slashed.replace(/^(?:\.\/)+/u, '')
  const normalized = posix.normalize(withoutDot)
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    WINDOWS_ABSOLUTE_PATTERN.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`TIA protocol paths must be project-relative: ${value}`)
  }
  return normalized
}

export function normalizeProtocolPaths(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeProtocolPath))].sort()
}
