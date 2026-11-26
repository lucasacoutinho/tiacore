import {
  RECORD_FAMILIES,
  type RecordFamily,
  type TiaRuntimeGraph,
} from '../../core/runtime.ts'
import { pruneCoverageMaps } from './coverage.ts'
import { graphGeneration } from './segments.ts'
import { emptyGraph } from './update.ts'

// Partition merge. proofs/Tia/Merge.lean models it: `mergeAll_spec`,
// `mergeAll_conflict`, `merge_complete` and `merge_missing`. A fragment joins
// the merge when it agrees with the first fragment on total, group,
// fingerprint and baseline, is itself partial, and has an index in 1..total.
// The merge succeeds only when every index is present exactly once (equal
// generations may repeat) and no record key carries two different values.
// `mergeFamilies` also serves the commit reconciliation (reconcile.ts): the
// partition merge is its three-way merge from an empty base.

export type Equivalent = (left: unknown, right: unknown) => boolean

export const same: Equivalent = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right)

/**
 * Content-addressed maps never conflict: each side's maps are added and the
 * unreferenced ones pruned afterwards. Every other family merges key by key.
 */
const KEYED_FAMILIES = RECORD_FAMILIES.filter(
  (family): family is Exclude<RecordFamily, 'coverageMaps'> =>
    family !== 'coverageMaps',
)

function mergeChangedRecord(
  expected: Readonly<Record<string, unknown>>,
  current: Record<string, unknown>,
  proposed: Readonly<Record<string, unknown>>,
  equivalent: Equivalent,
): boolean {
  // A key none of the three changed, or only `current` holds, stays as it is.
  const keys = new Set([...Object.keys(expected), ...Object.keys(proposed)])
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

/**
 * Applies `proposed`'s changes since `expected` (nothing, when null) to every
 * keyed record of `current`, in place. False when both sides changed a key to
 * different values; `current` is then partly merged. Values compare by their
 * JSON unless `equivalent` names a family's own rule.
 */
export function mergeFamilies(
  expected: TiaRuntimeGraph | null,
  current: TiaRuntimeGraph,
  proposed: TiaRuntimeGraph,
  equivalent: Partial<Record<RecordFamily, Equivalent>> = {},
): boolean {
  return KEYED_FAMILIES.every((family) =>
    mergeChangedRecord(
      expected?.[family] ?? {},
      current[family],
      proposed[family],
      equivalent[family] ?? same,
    ),
  )
}

/** A partition merge and which of its fragments it used. */
export interface PartitionMerge {
  graph: TiaRuntimeGraph
  /** Positions in the input of the fragments merged, by partition index. */
  used: number[]
}

/**
 * `mergePartitionedGraphs`, also naming the fragments the merge used. A
 * fragment that does not join the merge is not among them, nor is one whose
 * index a later fragment of equal generation holds.
 */
export function mergePartitionedFragments(
  fragments: readonly TiaRuntimeGraph[],
): PartitionMerge | null {
  const first = fragments[0]
  if (first?.partition === undefined) return null

  const { group, total } = first.partition
  if (!Number.isInteger(total) || total < 1) return null
  const baseline = JSON.stringify(first.baseline)
  const fingerprint = first.fingerprint
  const partitions = new Map<
    number,
    { fragment: TiaRuntimeGraph; position: number }
  >()

  for (const [position, fragment] of fragments.entries()) {
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
      graphGeneration(existing.fragment) !== graphGeneration(fragment)
    ) {
      return null
    }
    partitions.set(partition.index, { fragment, position })
  }

  if (partitions.size !== total) return null

  const merged: TiaRuntimeGraph = {
    ...emptyGraph(),
    baseline: structuredClone(first.baseline),
    complete: true,
    coverageComplete: true,
    fingerprint,
    schema: first.schema,
  }

  const used: number[] = []
  for (let index = 1; index <= total; index += 1) {
    const held = partitions.get(index)
    if (held === undefined || !mergeFamilies(null, merged, held.fragment)) {
      return null
    }
    const { fragment } = held
    Object.assign(merged.coverageMaps, fragment.coverageMaps)
    merged.coverageComplete &&= fragment.coverageComplete
    if (fragment.updatedAt > merged.updatedAt) {
      merged.updatedAt = fragment.updatedAt
    }
    used.push(held.position)
  }

  pruneCoverageMaps(merged)
  return { graph: merged, used }
}

export function mergePartitionedGraphs(
  fragments: readonly TiaRuntimeGraph[],
): TiaRuntimeGraph | null {
  return mergePartitionedFragments(fragments)?.graph ?? null
}
