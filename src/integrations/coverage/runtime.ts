import type {
  CoverageFile,
  CoverageMapLike,
  TiaCoverageMap,
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
    f: { ...(file.f ?? {}) },
    s: { ...(file.s ?? {}) },
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
  return Object.fromEntries(
    Object.entries(after ?? {}).map(([key, count]) => [
      key,
      Math.max(0, count - (before?.[key] ?? 0)),
    ]),
  )
}

function branchDelta(
  before: Record<string, number[]> | undefined,
  after: Record<string, number[]> | undefined,
): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(after ?? {}).map(([key, counts]) => [
      key,
      counts.map((count, index) =>
        Math.max(0, count - (before?.[key]?.[index] ?? 0)),
      ),
    ]),
  )
}

function hasHits(file: {
  b: Record<string, number[]>
  f: Record<string, number>
  s: Record<string, number>
}): boolean {
  return (
    Object.values(file.s).some((count) => count > 0) ||
    Object.values(file.f).some((count) => count > 0) ||
    Object.values(file.b).some((counts) =>
      counts.some((count) => count > 0),
    )
  )
}

export function coverageDelta(
  before: CoverageSnapshotMap,
  coverage: CoverageMapLike | undefined,
): TiaCoverageMap {
  if (coverage === undefined) {
    return {}
  }

  const delta: TiaCoverageMap = {}

  for (const [key, file] of Object.entries(coverage)) {
    const path = file.path ?? key
    const counters = {
      b: branchDelta(before[path]?.b, file.b),
      f: scalarDelta(before[path]?.f, file.f),
      s: scalarDelta(before[path]?.s, file.s),
    }
    if (!hasHits(counters)) {
      continue
    }

    delta[path] = {
      b: counters.b,
      branchMap: structuredClone(file.branchMap ?? {}),
      f: counters.f,
      fnMap: structuredClone(file.fnMap ?? {}),
      path,
      s: counters.s,
      statementMap: structuredClone(file.statementMap ?? {}),
    }
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
  const merged = structuredClone(left)
  for (const [key, values] of Object.entries(right)) {
    const previous = merged[key] ?? []
    merged[key] = Array.from(
      { length: Math.max(previous.length, values.length) },
      (_, index) => (values[index] ?? 0) + (previous[index] ?? 0),
    )
  }
  return merged
}

export function mergeCoverageMaps(
  ...maps: TiaCoverageMap[]
): TiaCoverageMap {
  const merged: TiaCoverageMap = {}

  for (const map of maps) {
    for (const [path, file] of Object.entries(map)) {
      const previous = merged[path]
      if (previous === undefined) {
        merged[path] = structuredClone(file)
        continue
      }

      merged[path] = {
        ...structuredClone(file),
        b: mergeBranchCounters(previous.b, file.b),
        f: mergeScalarCounters(previous.f, file.f),
        s: mergeScalarCounters(previous.s, file.s),
      }
    }
  }

  return merged
}
