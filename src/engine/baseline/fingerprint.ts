import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  PLUGIN_VERSION,
  STRUCTURAL_FILE_PATTERN,
} from '../../shared/constants.js'
import type { FingerprintOptions } from '../types.js'

export const DELETED_HASH = '<deleted>'
export const UNAVAILABLE_HASH = '<unavailable>'

export function hashBytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashFile(path: string): string {
  if (!existsSync(path)) {
    return DELETED_HASH
  }

  try {
    return hashBytes(readFileSync(path))
  } catch (error) {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      ? DELETED_HASH
      : UNAVAILABLE_HASH
  }
}

export function projectFingerprint(
  root: string,
  options: FingerprintOptions,
  extraFiles: string[] = [],
): string {
  const names = new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && STRUCTURAL_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name),
  )

  for (const file of extraFiles) {
    if (file !== '') {
      names.add(file)
    }
  }

  const structural = [...names]
    .sort()
    .map((name) => [name, hashFile(join(root, name))])

  return hashBytes(
    JSON.stringify({
      arch: process.arch,
      exclude: options.exclude,
      frameworks: options.frameworkFingerprint,
      ignoreChanges: options.ignoreChanges,
      include: options.include,
      node: process.versions.node.split('.')[0],
      onUnknownChange: options.onUnknownChange,
      platform: process.platform,
      plugin: PLUGIN_VERSION,
      structural,
    }),
  )
}
