import { createHash } from 'node:crypto'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { byCodeUnit } from '../../core/canonical.ts'
import type { FingerprintOptions } from './options.ts'
import { VERSION } from '../../core/version.ts'
import { ioError } from '../../wire/errors.ts'

export const DELETED_HASH = '<deleted>'
export const UNAVAILABLE_HASH = '<unavailable>'

/** Files of this size or larger are not hashed (Node cannot read them whole). */
export const MAX_HASHED_BYTES = 2 ** 31

/** Files in the project root whose change invalidates every recorded graph. */
export const STRUCTURAL_FILE_PATTERN =
  /^(?:package\.json|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)|(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json|(?:vite|vitest)(?:\.[^.]+)?\.config\.[cm]?[jt]s)$/u

/** The lowercase hex SHA-256 digest of `value`. */
export function hashBytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * The content hash of a file, `<deleted>` when it does not exist, and
 * `<unavailable>` when it cannot be hashed: a directory (including a symlink
 * to one), anything that is not a regular file, a file of 2 GiB or more, or a
 * read error. A baseline that holds `<unavailable>` is never recorded.
 */
export const hashFile = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.flatMap((info) =>
      info.type !== 'File' || Number(info.size) >= MAX_HASHED_BYTES
        ? Effect.succeed(UNAVAILABLE_HASH)
        : fs.readFile(path).pipe(Effect.map(hashBytes)),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        error.reason._tag === 'NotFound' ? DELETED_HASH : UNAVAILABLE_HASH,
      ),
    ),
  )

/**
 * Digest of the project's structure: the plugin options, the platform, the
 * Node major version, tiacore's version and the hashes of the root directory's
 * structural files (package manifests, lock files, tsconfig, vite config) plus
 * `extraFiles`. A cache or artifact from another structure is never reused.
 */
export const projectFingerprint = Effect.fn('tia.baseline.fingerprint')(
  function* (
    root: string,
    options: FingerprintOptions,
    extraFiles: readonly string[] = [],
  ) {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.readDirectory(root).pipe(Effect.mapError(ioError))
    const matching = entries.filter((name) =>
      STRUCTURAL_FILE_PATTERN.test(name),
    )
    const plain = yield* Effect.forEach(matching, (name) =>
      fs.lstat(join(root, name)).pipe(
        Effect.map((info) => info.type === 'File'),
        Effect.orElseSucceed(() => false),
      ),
    )
    const names = new Set(matching.filter((_, index) => plain[index] === true))
    for (const file of extraFiles) {
      if (file !== '') names.add(file)
    }
    const structural = yield* Effect.forEach(
      [...names].sort(byCodeUnit),
      (name) =>
        hashFile(fs, join(root, name)).pipe(
          Effect.map((hash): [string, string] => [name, hash]),
        ),
    )

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
        plugin: VERSION,
        structural,
      }),
    )
  },
)
