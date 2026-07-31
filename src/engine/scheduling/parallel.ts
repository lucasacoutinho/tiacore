import { availableParallelism } from 'node:os'

export function normalizedConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return Math.max(1, Math.min(4, availableParallelism()))
  }
  return Math.max(1, Math.floor(value))
}

export function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const value of values) {
    const group = key(value)
    const items = groups.get(group) ?? []
    items.push(value)
    groups.set(group, items)
  }
  return groups
}

export async function parallelMap<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array<R>(values.length)
  let next = 0

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next
        next += 1
        results[index] = await worker(values[index]!, index)
      }
    }),
  )

  return results
}
