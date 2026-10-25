import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { cloneGraph, pruneCoverageMaps } from './coverage.ts'

// Three-way merge of two writers that planned from the same graph. Their
// changes combine only when they touch different keys or agree on the value.

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Results are equal when they differ only in their measured duration. */
function sameResult(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return same(left, right)
  const { duration: _left, ...leftValue } = left
  const { duration: _right, ...rightValue } = right
  return same(leftValue, rightValue)
}

function mergeChangedRecord(
  expected: Readonly<Record<string, unknown>>,
  current: Record<string, unknown>,
  proposed: Readonly<Record<string, unknown>>,
  equivalent: (left: unknown, right: unknown) => boolean,
): boolean {
  const keys = new Set([
    ...Object.keys(expected),
    ...Object.keys(current),
    ...Object.keys(proposed),
  ])
  for (const key of keys) {
    const before = expected[key]
    const ours = proposed[key]
    const theirs = current[key]
    if (equivalent(ours, before)) continue
    if (!equivalent(theirs, before) && !equivalent(ours, theirs)) return false
    if (ours === undefined) delete current[key]
    else current[key] = structuredClone(ours)
  }
  return true
}

function compatibleCommit(
  left: TiaRuntimeGraph,
  right: TiaRuntimeGraph,
): boolean {
  return (
    left.schema === right.schema &&
    left.fingerprint === right.fingerprint &&
    left.complete === right.complete &&
    left.coverageComplete === right.coverageComplete &&
    same(left.baseline, right.baseline) &&
    same(left.partition, right.partition)
  )
}

const EMPTY_RECORDS = {
  collectionCoverage: {},
  collectionFiles: {},
  edges: {},
  results: {},
  testCoverage: {},
  testEdges: {},
}

/**
 * Applies `proposed`'s changes since `expected` onto `current`. Null when the
 * two commits disagree on identity fields or changed the same key differently.
 */
export function mergeConcurrentGraphs(
  expected: TiaRuntimeGraph | null,
  current: TiaRuntimeGraph,
  proposed: TiaRuntimeGraph,
): TiaRuntimeGraph | null {
  if (!compatibleCommit(current, proposed)) return null

  const before = expected ?? EMPTY_RECORDS
  const merged = cloneGraph(current)
  if (
    !mergeChangedRecord(
      before.collectionCoverage,
      merged.collectionCoverage,
      proposed.collectionCoverage,
      same,
    ) ||
    !mergeChangedRecord(
      before.collectionFiles,
      merged.collectionFiles,
      proposed.collectionFiles,
      same,
    ) ||
    !mergeChangedRecord(before.edges, merged.edges, proposed.edges, same) ||
    !mergeChangedRecord(
      before.results,
      merged.results,
      proposed.results,
      sameResult,
    ) ||
    !mergeChangedRecord(
      before.testCoverage,
      merged.testCoverage,
      proposed.testCoverage,
      same,
    ) ||
    !mergeChangedRecord(
      before.testEdges,
      merged.testEdges,
      proposed.testEdges,
      same,
    )
  ) {
    return null
  }

  Object.assign(merged.coverageMaps, proposed.coverageMaps)
  pruneCoverageMaps(merged)
  merged.updatedAt =
    proposed.updatedAt > current.updatedAt
      ? proposed.updatedAt
      : current.updatedAt
  return merged
}
