import { join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'

import {
  type ArchiveFile,
  archiveKey,
  isArchiveKey,
  MANIFEST_KEY,
  pruneCandidates,
  type RetentionPolicy,
} from '../../core/artifact-retention.ts'
import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_MANIFEST_BYTES,
} from '../../core/artifacts.ts'
import { byCodeUnit } from '../../core/canonical.ts'
import { readArchiveAttestation } from './archive.ts'
import { readManifest } from './schema.ts'

// Bounded retention for a filesystem artifact directory. It runs after the
// publisher has written a manifest, so the archive just published is always
// referenced. It removes only `tiacore-<24 hex digits>.zip` files directly in
// the directory, and every failure leaves the archive in place.

/**
 * Most promoted archives kept outside the retention window. The newest
 * promoted archive of each runner and fingerprint is kept, and a directory
 * holds a few of those. The cap stops archives that claim to be promoted, whose
 * signature this code does not check, from keeping the directory unbounded.
 */
const MAX_PROMOTED_KEPT = 32

interface StoredArchive extends ArchiveFile {
  size: number
}

/**
 * The archive names a manifest lists, by digest and by the last segment of the
 * url. Null when the body is not a version 1 manifest.
 */
function referencedKeys(body: Uint8Array): Set<string> | null {
  let document: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return null
  }
  const manifest = readManifest(document)
  if (manifest === null) return null
  const keys = new Set<string>()
  for (const entry of manifest.artifacts) {
    if (entry.sha256 !== undefined) keys.add(archiveKey(entry.sha256))
    const name = entry.url.split(/[?#]/u)[0]?.split('/').at(-1)
    if (name !== undefined && isArchiveKey(name)) keys.add(name)
  }
  return keys
}

/**
 * The newest unexpired promoted archive of each runner and fingerprint among
 * `candidates` (newest first). An archive that cannot be read is kept, because
 * nothing is known about it.
 */
const promotedToKeep = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  candidates: readonly StoredArchive[],
  nowMs: number,
) {
  const kept = new Set<string>()
  const lines = new Set<string>()
  for (const archive of candidates) {
    if (lines.size >= MAX_PROMOTED_KEPT) break
    if (archive.size > MAX_ARTIFACT_ARCHIVE_BYTES) continue
    const bytes = yield* fs
      .readFile(join(directory, archive.key))
      .pipe(Effect.option)
    if (Option.isNone(bytes)) {
      kept.add(archive.key)
      continue
    }
    const claim = readArchiveAttestation(bytes.value)?.claim
    if (claim === undefined || !claim.promoted) continue
    // Every consumer rejects an expired attestation, so keeping one helps no restore.
    if (Date.parse(claim.expiresAt) <= nowMs) continue
    const line = JSON.stringify([claim.runner ?? null, claim.fingerprint])
    if (lines.has(line)) continue
    lines.add(line)
    kept.add(archive.key)
  }
  return kept
})

/**
 * Removes archives beyond the policy from `directory`. `written` is the body of
 * the manifest that was just put. Nothing is removed when the manifest, or the
 * one now on disk after a concurrent publish, is not a version 1 manifest.
 */
export const pruneArtifactDirectory = Effect.fnUntraced(function* (
  directory: string,
  policy: RetentionPolicy,
  written: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem
  const keys = (yield* fs.readDirectory(directory))
    .filter(isArchiveKey)
    .sort(byCodeUnit)
  if (keys.length <= policy.keep && policy.maxAgeMs === undefined) return

  // The manifest on disk may belong to a publisher that finished after this one
  // wrote its own, so both are read.
  const manifestPath = join(directory, MANIFEST_KEY)
  const manifestSize = Number((yield* fs.stat(manifestPath)).size)
  if (manifestSize > MAX_MANIFEST_BYTES) return
  const own = referencedKeys(written)
  const current = referencedKeys(yield* fs.readFile(manifestPath))
  if (own === null || current === null) return

  const nowMs = yield* Clock.currentTimeMillis
  const archives: StoredArchive[] = []
  for (const key of keys) {
    const info = yield* fs.lstat(join(directory, key)).pipe(Effect.option)
    if (Option.isNone(info) || info.value.type !== 'File') continue
    archives.push({
      key,
      modifiedMs: Option.match(info.value.mtime, {
        onNone: () => nowMs,
        onSome: (time) => time.getTime(),
      }),
      size: Number(info.value.size),
    })
  }
  const candidates = pruneCandidates(
    archives,
    policy,
    nowMs,
    new Set([...own, ...current]),
  )
  if (candidates.length === 0) return

  const promoted = yield* promotedToKeep(fs, directory, candidates, nowMs)
  for (const { key } of candidates) {
    if (promoted.has(key)) continue
    // A reader may hold the file open; the next publish tries again.
    yield* fs.remove(join(directory, key), { force: true }).pipe(Effect.ignore)
  }
})
