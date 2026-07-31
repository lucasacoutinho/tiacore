import { join } from 'node:path'

import { hashBytes } from '../baseline/fingerprint.js'
import { mergePartitionedGraphs } from './merge.js'
import {
  commitGraph,
  graphDigest,
  readGraph,
} from './store.js'
import type {
  Baseline,
  TiaRuntimeGraph,
  TiaRuntimeGraphPartition,
} from '../types.js'

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

export async function aggregateLocalPartitions(
  cacheDir: string,
  partition: TiaRuntimeGraphPartition,
): Promise<TiaRuntimeGraph | null> {
  const fragments: TiaRuntimeGraph[] = []
  for (let index = 1; index <= partition.total; index += 1) {
    const graph = readGraph(
      partitionCacheDir(cacheDir, { ...partition, index }),
    )
    if (graph === null) {
      return null
    }
    fragments.push(graph)
  }

  const merged = mergePartitionedGraphs(fragments)
  if (merged === null) {
    return null
  }

  const expected = readGraph(cacheDir)
  const committed = await commitGraph(cacheDir, {
    expected,
    expectedDigest: graphDigest(expected),
    graph: merged,
  })
  return committed.status === 'conflict' ? null : committed.graph
}
