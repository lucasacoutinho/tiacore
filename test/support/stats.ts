/** The middle value of `values` (the upper one of an even count). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}
