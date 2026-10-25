import type {
  CoverageFile,
  CoverageMapLike,
  TiaCoverageCounterMap,
} from './types.js'

interface CoverageSnapshot {
  b: Record<string, number[]>
  f: Record<string, number>
  s: Record<string, number>
}

export type CoverageSnapshotMap = Record<string, CoverageSnapshot>

function cloneCounters(file: CoverageFile): CoverageSnapshot {
  return {
    b: Object.fromEntries(
      Object.entries(file.b ?? {}).map(([key, values]) => [key, [...values]]),
    ),
    f: { ...file.f },
    s: { ...file.s },
  }
}

export function snapshotCoverage(
  coverage: CoverageMapLike | undefined,
): CoverageSnapshotMap {
  if (coverage === undefined) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(coverage).map(([path, file]) => [
      file.path ?? path,
      cloneCounters(file),
    ]),
  )
}

function scalarAdvanced(
  before: Record<string, number> | undefined,
  after: Record<string, number> | undefined,
): boolean {
  for (const [key, count] of Object.entries(after ?? {})) {
    if (count > (before?.[key] ?? 0)) {
      return true
    }
  }

  return false
}

function branchAdvanced(
  before: Record<string, number[]> | undefined,
  after: Record<string, number[]> | undefined,
): boolean {
  for (const [key, counts] of Object.entries(after ?? {})) {
    const previous = before?.[key] ?? []

    if (counts.some((count, index) => count > (previous[index] ?? 0))) {
      return true
    }
  }

  return false
}

export function executedFilesSince(
  before: CoverageSnapshotMap,
  coverage: CoverageMapLike | undefined,
): string[] {
  if (coverage === undefined) {
    return []
  }

  const executed: string[] = []

  for (const [key, file] of Object.entries(coverage)) {
    const path = file.path ?? key
    const previous = before[path]

    if (
      scalarAdvanced(previous?.s, file.s) ||
      scalarAdvanced(previous?.f, file.f) ||
      branchAdvanced(previous?.b, file.b)
    ) {
      executed.push(path)
    }
  }

  return [...new Set(executed)].sort()
}

function scalarDelta(
  before: Record<string, number> | undefined,
  after: Record<string, number> | undefined,
): Record<string, number> {
  const delta: Record<string, number> = {}
  for (const [key, count] of Object.entries(after ?? {})) {
    const advanced = count - (before?.[key] ?? 0)
    if (advanced > 0) {
      delta[key] = advanced
    }
  }
  return delta
}

function branchDelta(
  before: Record<string, number[]> | undefined,
  after: Record<string, number[]> | undefined,
): Record<string, number[]> {
  const delta: Record<string, number[]> = {}
  for (const [key, counts] of Object.entries(after ?? {})) {
    const advanced = counts.map((count, index) =>
      Math.max(0, count - (before?.[key]?.[index] ?? 0)),
    )
    if (advanced.some((count) => count > 0)) {
      delta[key] = advanced
    }
  }
  return delta
}

function isEmpty(record: Record<string, unknown>): boolean {
  for (const _ in record) {
    return false
  }
  return true
}

/**
 * Returns only the counters that advanced since `before`, keyed by file and
 * tagged with Istanbul's instrumentation hash. The static statement, function,
 * and branch maps stay out of the delta; `expandCoverageCounters` restores them.
 */
export function coverageCounterDelta(
  before: CoverageSnapshotMap,
  coverage: CoverageMapLike | undefined,
): TiaCoverageCounterMap {
  if (coverage === undefined) {
    return {}
  }

  const delta: TiaCoverageCounterMap = {}

  for (const [key, file] of Object.entries(coverage)) {
    const path = file.path ?? key
    const counters = {
      b: branchDelta(before[path]?.b, file.b),
      f: scalarDelta(before[path]?.f, file.f),
      s: scalarDelta(before[path]?.s, file.s),
    }
    if (isEmpty(counters.s) && isEmpty(counters.f) && isEmpty(counters.b)) {
      continue
    }

    delta[path] = { ...counters, hash: file.hash ?? '' }
  }

  return delta
}

function mergeScalarCounters(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const merged = { ...left }
  for (const [key, value] of Object.entries(right)) {
    merged[key] = (merged[key] ?? 0) + value
  }
  return merged
}

function mergeBranchCounters(
  left: Record<string, number[]>,
  right: Record<string, number[]>,
): Record<string, number[]> {
  const merged = { ...left }
  for (const [key, values] of Object.entries(right)) {
    const previous = merged[key] ?? []
    merged[key] = Array.from(
      { length: Math.max(previous.length, values.length) },
      (_, index) => (values[index] ?? 0) + (previous[index] ?? 0),
    )
  }
  return merged
}

export function mergeCoverageCounters(
  ...maps: TiaCoverageCounterMap[]
): TiaCoverageCounterMap {
  const merged: TiaCoverageCounterMap = {}

  for (const map of maps) {
    for (const [path, file] of Object.entries(map)) {
      const previous = merged[path]
      merged[path] =
        previous === undefined
          ? file
          : {
              b: mergeBranchCounters(previous.b, file.b),
              f: mergeScalarCounters(previous.f, file.f),
              hash: file.hash,
              s: mergeScalarCounters(previous.s, file.s),
            }
    }
  }

  return merged
}
