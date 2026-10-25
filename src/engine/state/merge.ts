import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { pruneCoverageMaps } from './coverage.ts'
import { graphGeneration } from './segments.ts'

// Partition merge. proofs/Tia/Merge.lean models it: `mergeAll_spec`,
// `mergeAll_conflict`, `merge_complete` and `merge_missing`. A fragment joins
// the merge when it agrees with the first fragment on total, group,
// fingerprint and baseline, is itself partial, and has an index in 1..total.
// The merge succeeds only when every index is present exactly once (equal
// generations may repeat) and no record key carries two different values.

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

function mergeRecord<T>(
  target: Record<string, T>,
  source: Readonly<Record<string, T>>,
): boolean {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (current !== undefined && !same(current, value)) return false
    target[key] = structuredClone(value)
  }
  return true
}

export function mergePartitionedGraphs(
  fragments: readonly TiaRuntimeGraph[],
): TiaRuntimeGraph | null {
  const first = fragments[0]
  if (first?.partition === undefined) return null

  const { group, total } = first.partition
  if (!Number.isInteger(total) || total < 1) return null
  const baseline = JSON.stringify(first.baseline)
  const fingerprint = first.fingerprint
  const partitions = new Map<number, TiaRuntimeGraph>()

  for (const fragment of fragments) {
    const partition = fragment.partition
    if (
      partition === undefined ||
      partition.total !== total ||
      partition.group !== group ||
      !Number.isInteger(partition.index) ||
      partition.index < 1 ||
      partition.index > total ||
      fragment.complete ||
      fragment.fingerprint !== fingerprint ||
      JSON.stringify(fragment.baseline) !== baseline
    ) {
      continue
    }

    const existing = partitions.get(partition.index)
    if (
      existing !== undefined &&
      graphGeneration(existing) !== graphGeneration(fragment)
    ) {
      return null
    }
    partitions.set(partition.index, fragment)
  }

  if (partitions.size !== total) return null

  const merged: TiaRuntimeGraph = {
    baseline: structuredClone(first.baseline),
    collectionCoverage: {},
    collectionFiles: {},
    complete: true,
    coverageComplete: true,
    coverageMaps: {},
    edges: {},
    fingerprint,
    results: {},
    schema: first.schema,
    testCoverage: {},
    testEdges: {},
    updatedAt: '',
  }

  for (let index = 1; index <= total; index += 1) {
    const fragment = partitions.get(index)
    if (fragment === undefined) return null
    if (
      !mergeRecord(merged.edges, fragment.edges) ||
      !mergeRecord(merged.results, fragment.results) ||
      !mergeRecord(merged.testEdges, fragment.testEdges) ||
      !mergeRecord(merged.collectionCoverage, fragment.collectionCoverage) ||
      !mergeRecord(merged.collectionFiles, fragment.collectionFiles) ||
      !mergeRecord(merged.testCoverage, fragment.testCoverage)
    ) {
      return null
    }
    Object.assign(merged.coverageMaps, fragment.coverageMaps)
    merged.coverageComplete &&= fragment.coverageComplete
    if (fragment.updatedAt > merged.updatedAt) {
      merged.updatedAt = fragment.updatedAt
    }
  }

  pruneCoverageMaps(merged)
  return merged
}
