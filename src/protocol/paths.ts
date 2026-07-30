import { posix } from 'node:path'

const URI_PATTERN = /^[a-z][a-z0-9+.-]*:/iu
const WINDOWS_ABSOLUTE_PATTERN = /^[a-z]:\//iu

export function normalizeProtocolPath(value: string): string {
  const slashed = value.replaceAll('\\', '/')
  const withoutDot = slashed.replace(/^(?:\.\/)+/u, '')
  const normalized = posix.normalize(withoutDot)
  if (
    value.includes('\0') ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    URI_PATTERN.test(normalized) ||
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
