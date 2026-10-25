import { strFromU8, unzipSync, zipSync } from 'fflate'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  isSafeRelativePath,
  isSafeRunner,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_ARTIFACT_GRAPH_BYTES,
  type TiaArtifactAttestationV1,
} from '../../core/artifacts.ts'
import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { hashBytes } from '../baseline/fingerprint.ts'
import { parseArtifactGraph } from './portable-graph.ts'
import { parseArtifactAttestation } from './trust.ts'

// Archives are untrusted input read in memory. Beyond the exact-name allowlist
// and the per-entry size cap, a reader bounds the entry count, the total
// inflated size across the archive and any nested archives, the number of
// nested archives, and how far one entry may expand relative to its stored
// size. Declared sizes are checked before anything is inflated.

export { MAX_ARTIFACT_ARCHIVE_BYTES, MAX_ARTIFACT_GRAPH_BYTES }

/** Most entries a central directory may list. */
export const MAX_ARCHIVE_ENTRIES = 10_000
/** Most bytes all admitted entries of one read may inflate to, nested included. */
export const MAX_ARCHIVE_EXPANDED_BYTES = 64 * 1024 * 1024
/** Most nested archives one read will open. */
export const MAX_NESTED_ARCHIVES = 8
/** Entries at or below this inflated size are exempt from the ratio limit. */
export const RATIO_FLOOR_BYTES = 1024 * 1024
/** Largest inflated-to-stored size ratio of an entry above the floor. */
export const MAX_COMPRESSION_RATIO = 500

export interface TiaArtifactArchive {
  attestation?: TiaArtifactAttestationV1
  graph: TiaRuntimeGraph
  graphSha256: string
}

const NESTED_ARCHIVE_PATTERN = /(?:^|\/)tiacore-[a-f0-9]{24}\.zip$/u

interface Budget {
  expanded: number
  nested: number
}

/**
 * Inflates the entries `wanted` accepts. Null when the archive is corrupt,
 * names an unsafe entry, or breaks a size, count or expansion limit; every
 * entry is checked against its declared sizes before it is inflated.
 */
function extract(
  archive: Uint8Array,
  wanted: (name: string) => boolean,
  nested: boolean,
  budget: Budget,
): Record<string, Uint8Array> | null {
  let listed = 0
  let rejected = false
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, {
      filter: (entry) => {
        listed += 1
        if (listed > MAX_ARCHIVE_ENTRIES || !isSafeRelativePath(entry.name)) {
          rejected = true
          return false
        }
        if (
          !wanted(entry.name) ||
          entry.originalSize > MAX_ARTIFACT_GRAPH_BYTES
        ) {
          return false
        }
        budget.expanded += entry.originalSize
        if (nested) budget.nested += 1
        if (
          budget.expanded > MAX_ARCHIVE_EXPANDED_BYTES ||
          budget.nested > MAX_NESTED_ARCHIVES ||
          (entry.originalSize > RATIO_FLOOR_BYTES &&
            entry.originalSize > entry.size * MAX_COMPRESSION_RATIO)
        ) {
          rejected = true
          return false
        }
        return true
      },
    })
  } catch {
    return null
  }
  return rejected ? null : entries
}

function readArchive(
  archive: Uint8Array,
  runner: string | undefined,
  depth: number,
  budget: Budget,
): TiaArtifactArchive | null {
  if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
    return null
  }

  const graphPaths =
    runner === undefined
      ? ['graph.json', '.tia/graph.json']
      : [`${runner}/graph.json`, `.tia/${runner}/graph.json`]
  const attestationPaths =
    runner === undefined
      ? ['attestation.json', '.tia/attestation.json']
      : [
          `${runner}/attestation.json`,
          `.tia/${runner}/attestation.json`,
          'attestation.json',
        ]
  const allowedPaths = new Set([...graphPaths, ...attestationPaths])
  const entries = extract(
    archive,
    (name) => allowedPaths.has(name),
    false,
    budget,
  )
  if (entries === null) return null

  for (const path of graphPaths) {
    const bytes = entries[path]
    if (bytes === undefined || bytes.byteLength > MAX_ARTIFACT_GRAPH_BYTES) {
      continue
    }

    const graph = parseArtifactGraph(strFromU8(bytes))
    if (graph !== null) {
      let attestation: TiaArtifactAttestationV1 | undefined
      for (const attestationPath of attestationPaths) {
        const value = entries[attestationPath]
        if (value === undefined) continue
        try {
          const parsed = parseArtifactAttestation(JSON.parse(strFromU8(value)))
          if (parsed !== null) {
            attestation = parsed
            break
          }
        } catch {
          // A malformed attestation is handled by the trust policy.
        }
      }
      return {
        ...(attestation === undefined ? {} : { attestation }),
        graph,
        graphSha256: hashBytes(bytes),
      }
    }
  }

  // A CI service may wrap the publisher's archive; look one level down, and
  // only when the top level held no graph, so decoys are never inflated.
  if (depth === 0) {
    const inner = extract(
      archive,
      (name) => NESTED_ARCHIVE_PATTERN.test(name),
      true,
      budget,
    )
    if (inner === null) return null
    for (const [, bytes] of Object.entries(inner).sort(([left], [right]) =>
      byCodeUnit(left, right),
    )) {
      const found = readArchive(bytes, runner, depth + 1, budget)
      if (found !== null) return found
    }
  }

  return null
}

/**
 * The graph, attestation and graph digest an archive holds for `runner`, or
 * null when the archive is oversized, corrupt, names an unsafe entry, exceeds
 * an expansion limit or holds no valid graph.
 */
export function readArtifactArchive(
  archive: Uint8Array,
  runner: string | undefined,
): TiaArtifactArchive | null {
  if (runner !== undefined && !isSafeRunner(runner)) return null
  return readArchive(archive, runner, 0, { expanded: 0, nested: 0 })
}

/**
 * The attestation at the top level of a publisher's archive, or null when the
 * archive is oversized, corrupt, breaks a limit or holds no valid attestation.
 * Unlike `readArtifactArchive` it inflates nothing else, not even the graph.
 */
export function readArchiveAttestation(
  archive: Uint8Array,
): TiaArtifactAttestationV1 | null {
  if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) return null
  const entries = extract(
    archive,
    (name) => name === 'attestation.json',
    false,
    { expanded: 0, nested: 0 },
  )
  const bytes = entries?.['attestation.json']
  if (bytes === undefined) return null
  try {
    return parseArtifactAttestation(JSON.parse(strFromU8(bytes)))
  } catch {
    return null
  }
}

/** Zips `entries` in the order given with fixed timestamps: the output is deterministic. */
export function writeArtifactArchive(
  entries: ReadonlyArray<readonly [string, Uint8Array]>,
): Uint8Array {
  // Every entry carries the DOS epoch, so equal inputs give equal bytes. fflate
  // reads local-time fields, hence the date is built from local fields too.
  const mtime = new Date(1980, 0, 1, 0, 0, 0)
  return zipSync(
    Object.fromEntries(
      entries.map(([name, data]) => [
        name,
        [data, { level: 9, mtime }] as const,
      ]),
    ),
  )
}
