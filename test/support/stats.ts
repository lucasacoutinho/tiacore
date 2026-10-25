/** The middle value of `values` (the upper one of an even count). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/**
 * The statistical median: the middle value, or the mean of the two middle
 * values of an even count. Unlike `median`, it does not lean to one side, so a
 * benchmark of an even number of rounds is not biased upward.
 */
export function exactMedian(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const upper = Math.floor(sorted.length / 2)
  const high = sorted[upper] ?? Number.NaN
  return sorted.length % 2 === 1
    ? high
    : ((sorted[upper - 1] ?? Number.NaN) + high) / 2
}

/** The smallest value; NaN for no values. */
export function minimum(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : Math.min(...values)
}

/**
 * The median absolute deviation: the median distance of a value from the
 * median. Unlike the standard deviation, one wild round does not inflate it.
 */
export function mad(values: readonly number[]): number {
  const centre = exactMedian(values)
  return exactMedian(values.map((value) => Math.abs(value - centre)))
}
