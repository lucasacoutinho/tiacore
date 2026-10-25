import { relative } from 'node:path'

import coverageLibrary from 'istanbul-lib-coverage'
import type { CoverageMap, CoverageSummary } from 'istanbul-lib-coverage'
import picomatch from 'picomatch'

import { slash } from '../host-path.ts'
import type { TiaCoverageThresholds } from './types.ts'

const METRICS = ['lines', 'functions', 'statements', 'branches'] as const
const RESERVED_KEYS = new Set(['100', 'autoUpdate', 'perFile', ...METRICS])

type CoverageMetric = (typeof METRICS)[number]
type ResolvedValues = Partial<Record<CoverageMetric, number>>

interface ThresholdSet {
  coverageMap: CoverageMap
  /** True for a glob set that matched no file, which fails the threshold. */
  matchesNothing: boolean
  name: string
  values: ResolvedValues
}

export interface CoverageThresholdFailure {
  message: string
}

function metricValues(value: unknown): ResolvedValues {
  if (value === null || typeof value !== 'object') return {}
  if (Reflect.get(value, '100') === true) {
    return { branches: 100, functions: 100, lines: 100, statements: 100 }
  }
  const values: ResolvedValues = {}
  for (const metric of METRICS) {
    const threshold: unknown = Reflect.get(value, metric)
    if (typeof threshold === 'number' && Number.isFinite(threshold)) {
      values[metric] = threshold
    }
  }
  return values
}

function thresholdSets(
  coverageMap: CoverageMap,
  root: string,
  thresholds: TiaCoverageThresholds,
): ThresholdSet[] {
  const sets: ThresholdSet[] = [
    {
      coverageMap,
      matchesNothing: false,
      name: 'global',
      values: metricValues(thresholds),
    },
  ]
  const files = coverageMap.files()

  for (const [pattern, configured] of Object.entries(thresholds)) {
    if (RESERVED_KEYS.has(pattern)) {
      continue
    }

    const values = metricValues(configured)
    if (Object.keys(values).length === 0) {
      continue
    }

    const matcher = picomatch(pattern)
    const matching = coverageLibrary.createCoverageMap()
    for (const file of files) {
      if (matcher(slash(relative(root, file)))) {
        matching.addFileCoverage(coverageMap.fileCoverageFor(file))
      }
    }
    sets.push({
      coverageMap: matching,
      matchesNothing: matching.files().length === 0,
      name: `"${pattern}"`,
      values,
    })
  }

  return sets
}

function summaries(
  coverageMap: CoverageMap,
  perFile: boolean,
): Array<{ file: string | null; summary: CoverageSummary }> {
  if (!perFile) {
    return [{ file: null, summary: coverageMap.getCoverageSummary() }]
  }

  return coverageMap.files().map((file) => ({
    file,
    summary: coverageMap.fileCoverageFor(file).toSummary(),
  }))
}

export function coverageThresholdFailures(
  coverageMap: CoverageMap,
  root: string,
  thresholds: TiaCoverageThresholds | null,
): CoverageThresholdFailure[] {
  if (thresholds === null) {
    return []
  }

  const failures: CoverageThresholdFailure[] = []
  const perFile = thresholds.perFile === true

  for (const set of thresholdSets(coverageMap, root, thresholds)) {
    if (set.matchesNothing) {
      failures.push({
        message: `ERROR: Coverage threshold ${set.name} matches no files, so it cannot be met`,
      })
      continue
    }
    for (const { file, summary } of summaries(set.coverageMap, perFile)) {
      for (const metric of METRICS) {
        const threshold = set.values[metric]
        if (threshold === undefined) {
          continue
        }

        const total = summary.data[metric]
        const fileSuffix =
          perFile && file !== null ? ` for ${slash(relative(root, file))}` : ''

        if (threshold >= 0) {
          if (typeof total.pct === 'number' && total.pct < threshold) {
            failures.push({
              message:
                `ERROR: Coverage for ${metric} (${total.pct}%) does not meet ` +
                `${set.name} threshold (${threshold}%)${fileSuffix}`,
            })
          }
          continue
        }

        const uncovered = total.total - total.covered
        const maximum = threshold * -1
        if (uncovered > maximum) {
          failures.push({
            message:
              `ERROR: Uncovered ${metric} (${uncovered}) exceed ` +
              `${set.name} threshold (${maximum})${fileSuffix}`,
          })
        }
      }
    }
  }

  return failures
}
