import { isRecord } from '../../core/record.ts'
import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { cloneGraph, pruneCoverageMaps } from './coverage.ts'
import { mergeFamilies, same } from './merge.ts'

// Three-way merge of two writers that planned from the same graph. Their
// changes combine only when they touch different keys or agree on the value.

/** Results are equal when they differ only in their measured duration. */
function sameResult(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return same(left, right)
  const { duration: _left, ...leftValue } = left
  const { duration: _right, ...rightValue } = right
  return same(leftValue, rightValue)
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

  const merged = cloneGraph(current)
  if (!mergeFamilies(expected, merged, proposed, { results: sameResult })) {
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
