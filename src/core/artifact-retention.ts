import { byCodeUnit } from './canonical.ts'
import type { TiaArtifactRetentionOptions } from './artifacts.ts'

// The file layout of a filesystem artifact directory and the pure part of its
// retention: which archives are old enough to prune. Reading the directory,
// the manifest and the attestations is the engine's job (see
// src/engine/artifacts/retention.ts).

/** The manifest the publisher writes last; its write is when a publish succeeded. */
export const MANIFEST_KEY = 'manifest.json'

const ARCHIVE_KEY = /^tiacore-[a-f0-9]{24}\.zip$/u

/** The name an archive with this SHA-256 digest is stored under. */
export function archiveKey(sha256: string): string {
  return `tiacore-${sha256.slice(0, 24)}.zip`
}

/** Whether `name` is a file name the publisher gives its archives. */
export function isArchiveKey(name: string): boolean {
  return ARCHIVE_KEY.test(name)
}

/** Archives kept when no `keep` is given. */
export const DEFAULT_KEEP_ARCHIVES = 20

/**
 * An archive written this recently is never pruned. A concurrent publish
 * writes its archive before its manifest, so for that gap nothing references
 * the archive yet; a reader that listed the directory moments ago may also
 * still be about to open it.
 */
export const RETENTION_GRACE_MS = 10 * 60 * 1_000

const DAY_MS = 24 * 60 * 60 * 1_000

export interface RetentionPolicy {
  keep: number
  maxAgeMs: number | undefined
}

/** The first problem with retention options, if any. */
export function retentionProblem(
  retention: TiaArtifactRetentionOptions | false | undefined,
): string | null {
  if (retention === undefined || retention === false) return null
  const { keep, maxAgeDays } = retention
  if (keep !== undefined && !(Number.isSafeInteger(keep) && keep >= 1)) {
    return 'TIA artifact retention keep must be a positive integer'
  }
  if (
    maxAgeDays !== undefined &&
    !(Number.isFinite(maxAgeDays) && maxAgeDays > 0)
  ) {
    return 'TIA artifact retention maxAgeDays must be a positive number'
  }
  return null
}

/** The policy for valid options; null when retention is switched off. */
export function resolveRetention(
  retention: TiaArtifactRetentionOptions | false | undefined,
): RetentionPolicy | null {
  if (retention === false) return null
  return {
    keep: retention?.keep ?? DEFAULT_KEEP_ARCHIVES,
    maxAgeMs:
      retention?.maxAgeDays === undefined
        ? undefined
        : retention.maxAgeDays * DAY_MS,
  }
}

export interface ArchiveFile {
  key: string
  modifiedMs: number
}

/**
 * The archives that may be pruned, newest first. An archive is a candidate
 * when it is not among the `keep` newest or is older than the age limit; it is
 * not one when `shielded` names it or it was written within the grace period.
 * Files with a future modification time count as new.
 */
export function pruneCandidates<A extends ArchiveFile>(
  archives: readonly A[],
  policy: RetentionPolicy,
  nowMs: number,
  shielded: ReadonlySet<string>,
): A[] {
  const newestFirst = [...archives].sort(
    (left, right) =>
      right.modifiedMs - left.modifiedMs || byCodeUnit(left.key, right.key),
  )
  const tooOld =
    policy.maxAgeMs === undefined
      ? Number.NEGATIVE_INFINITY
      : nowMs - policy.maxAgeMs
  const graceStart = nowMs - RETENTION_GRACE_MS
  return newestFirst.filter(
    (archive, rank) =>
      (rank >= policy.keep || archive.modifiedMs < tooOld) &&
      archive.modifiedMs <= graceStart &&
      !shielded.has(archive.key),
  )
}
