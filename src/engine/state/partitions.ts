import { join } from 'node:path'

import * as Effect from 'effect/Effect'

import type {
  Baseline,
  TiaRuntimeGraph,
  TiaRuntimeGraphPartition,
} from '../../core/runtime.ts'
import { hashBytes } from '../baseline/fingerprint.ts'
import { GraphStore } from '../ports.ts'
import { mergePartitionedGraphs } from './merge.ts'

/**
 * The shard group name: the requested one trimmed, else a name derived from
 * the baseline, fingerprint and shard count, so local shards that start from
 * the same tree find each other.
 */
export function partitionGroup(
  baseline: Baseline | null,
  fingerprint: string,
  total: number,
  requested?: string,
): string {
  if (requested !== undefined && requested.trim() !== '') {
    return requested.trim()
  }
  return `local-${hashBytes(
    JSON.stringify({ baseline, fingerprint, total }),
  ).slice(0, 20)}`
}

/** Each shard keeps a complete, independent store under fragments/. */
export function partitionCacheDir(
  cacheDir: string,
  partition: TiaRuntimeGraphPartition,
): string {
  const group = partition.group ?? 'ungrouped'
  return join(
    cacheDir,
    'fragments',
    hashBytes(group).slice(0, 24),
    `${partition.index}-of-${partition.total}`,
  )
}

/**
 * Reads every shard's fragment and, when all are present and compatible,
 * commits their merge into the main store. Null when a fragment is missing,
 * the fragments do not merge, or the commit conflicts.
 */
export const aggregateLocalPartitions = Effect.fnUntraced(function* (
  cacheDir: string,
  partition: TiaRuntimeGraphPartition,
) {
  const store = yield* GraphStore
  const fragments: TiaRuntimeGraph[] = []
  for (let index = 1; index <= partition.total; index += 1) {
    const { graph } = yield* store.read(
      partitionCacheDir(cacheDir, { ...partition, index }),
    )
    if (graph === null) return null
    fragments.push(graph)
  }

  const merged = mergePartitionedGraphs(fragments)
  if (merged === null) return null

  const expected = yield* store.read(cacheDir)
  const committed = yield* store.commit(cacheDir, {
    expected: expected.graph,
    expectedDigest: expected.digest,
    graph: merged,
  })
  return committed.status === 'conflict' ? null : committed.graph
})
