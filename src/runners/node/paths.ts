import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * One canonical form for every path the Node runner compares: a `file:` URL
 * becomes a path, then the real path (macOS /private/var, Windows junctions
 * and short names), falling back to the resolved path when it does not exist.
 */
export function canonicalNodePath(value: string): string {
  const resolved = value.startsWith('file:')
    ? fileURLToPath(value)
    : resolve(value)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}
