// Combines the windows of several attempts at one test (Vitest `retry` and
// `repeats`). Every attempt ran the test, so the test depends on everything
// any attempt touched: an attempt that failed through a branch the passing
// attempt skipped still names a file whose change can change the outcome.

import { byCodeUnit } from '../core/canonical.ts'
import type {
  ProbeCounterMap,
  ProbeCounters,
  ProbeTestWindow,
} from './types.ts'

function sumCounts(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Record<string, number> {
  const total = { ...left }
  for (const [name, count] of Object.entries(right)) {
    total[name] = (total[name] ?? 0) + count
  }
  return total
}

function sumBranches(
  left: Readonly<Record<string, readonly number[]>>,
  right: Readonly<Record<string, readonly number[]>>,
): Record<string, number[]> {
  const total: Record<string, number[]> = {}
  for (const [name, counts] of Object.entries(left)) total[name] = [...counts]
  for (const [name, counts] of Object.entries(right)) {
    const before = total[name]
    total[name] =
      before === undefined
        ? [...counts]
        : counts.map((count, index) => count + (before[index] ?? 0))
  }
  return total
}

function sumCounters(left: ProbeCounters, right: ProbeCounters): ProbeCounters {
  // One module instruments a file once, so its attempts share one hash. A
  // different hash names different static maps; the later attempt's stands.
  if (left.hash !== right.hash) return right
  return {
    b: sumBranches(left.b, right.b),
    f: sumCounts(left.f, right.f),
    hash: right.hash,
    s: sumCounts(left.s, right.s),
  }
}

/** The union of two attempts' windows: every file, counters summed per file. */
export function mergeTestWindows(
  previous: ProbeTestWindow,
  next: ProbeTestWindow,
): ProbeTestWindow {
  const coverage: ProbeCounterMap = { ...previous.coverage }
  for (const [path, counters] of Object.entries(next.coverage)) {
    const before = coverage[path]
    coverage[path] =
      before === undefined ? counters : sumCounters(before, counters)
  }
  return {
    coverage,
    files: [...new Set([...previous.files, ...next.files])].sort(byCodeUnit),
  }
}
