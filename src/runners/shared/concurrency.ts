import { availableParallelism } from 'node:os'

/**
 * The bounded worker count for a runner: `min(4, available parallelism)` when
 * unset, otherwise the floor of the value, at least 1. NaN is rejected at the
 * public seam; 1.x started zero workers for it and silently dropped the work.
 */
export function normalizedConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return Math.max(1, Math.min(4, availableParallelism()))
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error('TIA concurrency must be a number')
  }
  return Math.max(1, Math.floor(value))
}

/** Groups values by key, keeping first-seen key order and value order. */
export function groupBy<T, K>(
  values: readonly T[],
  key: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const value of values) {
    const group = key(value)
    const items = groups.get(group)
    if (items === undefined) groups.set(group, [value])
    else items.push(value)
  }
  return groups
}
