import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import coverageLibrary from 'istanbul-lib-coverage'
import reportLibrary from 'istanbul-lib-report'
import reports from 'istanbul-reports'

import * as Effect from 'effect/Effect'
import type { ReportBase } from 'istanbul-lib-report'

import type { TiaCoverageHits, TiaRuntimeGraph } from '../../core/runtime.ts'
import { TiaIo } from '../../wire/errors.ts'
import { selectedCoverage } from './files.ts'
import { coverageRecords, expandCoverageHits } from './maps.ts'
import {
  coverageThresholdFailures,
  type CoverageThresholdFailure,
} from './thresholds.ts'
import type { TiaCoverageRuntime } from './types.ts'

const reportRegistry: object = reports

// istanbul-reports resolves a reporter by name when it runs and throws for an
// unknown one (COV-RPT-05); its typed signature only admits the built-ins.
const createReporter: (
  name: string,
  options: Record<string, unknown>,
) => ReportBase = Reflect.get(reportRegistry, 'create')

export interface CoverageReportResult {
  files: number
  thresholdFailures: CoverageThresholdFailure[]
  warnings: string[]
}

function addCounters(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + count
  }
}

/**
 * Merges every coverage record in the graph into one Istanbul coverage map.
 * Counters are summed per file and map first, so each file's maps are
 * expanded once instead of once per test.
 */
export function mergedGraphCoverage(
  graph: TiaRuntimeGraph,
  root: string,
): ReturnType<typeof coverageLibrary.createCoverageMap> {
  const totals = new Map<
    string,
    { hits: Omit<TiaCoverageHits, 'map'>; map: string; path: string }
  >()

  for (const record of coverageRecords(graph)) {
    for (const [path, hits] of Object.entries(record)) {
      const key = `${path}\0${hits.map}`
      let total = totals.get(key)
      if (total === undefined) {
        total = { hits: { b: {}, f: {}, s: {} }, map: hits.map, path }
        totals.set(key, total)
      }
      addCounters(total.hits.s, hits.s)
      addCounters(total.hits.f, hits.f)
      for (const [branch, counts] of Object.entries(hits.b)) {
        const previous = total.hits.b[branch] ?? []
        total.hits.b[branch] = Array.from(
          { length: Math.max(previous.length, counts.length) },
          (_, index) => (previous[index] ?? 0) + (counts[index] ?? 0),
        )
      }
    }
  }

  const merged = coverageLibrary.createCoverageMap()
  for (const { hits, map, path } of totals.values()) {
    const template = graph.coverageMaps[map]
    if (template === undefined) continue
    const absolute = resolve(root, path)
    // Istanbul may extend a file's maps while merging another version of the
    // same file, so the report works on its own copy of the shared maps.
    merged.merge({
      [absolute]: expandCoverageHits(structuredClone(template), absolute, hits),
    })
  }

  return merged
}

/**
 * Writes every configured reporter from the graph and evaluates thresholds.
 * Throws what istanbul-reports throws for an unknown reporter.
 */
export function renderCoverageReports(
  graph: TiaRuntimeGraph,
  root: string,
  options: TiaCoverageRuntime,
): CoverageReportResult {
  const selected = selectedCoverage(
    mergedGraphCoverage(graph, root),
    root,
    options,
  )
  const coverageMap = selected.coverage
  const context = reportLibrary.createContext({
    coverageMap,
    dir: options.reportsDirectory,
    sourceFinder: (file) => readFileSync(file, 'utf8'),
    watermarks: options.watermarks,
  })

  for (const reporter of options.reporters) {
    createReporter(reporter.name, {
      projectRoot: root,
      skipFull: options.skipFull,
      ...reporter.options,
    }).execute(context)
  }

  return {
    files: coverageMap.files().length,
    thresholdFailures: coverageThresholdFailures(
      coverageMap,
      root,
      options.thresholds,
    ),
    warnings: selected.warnings,
  }
}

/** The report stage: failures of the reporters surface as `TiaIo`. */
export const writeCoverageReports = Effect.fn('tia.coverage.report')(function* (
  graph: TiaRuntimeGraph,
  root: string,
  options: TiaCoverageRuntime,
) {
  return yield* Effect.try({
    catch: (error) =>
      new TiaIo({
        cause: error,
        message: error instanceof Error ? error.message : String(error),
      }),
    try: () => renderCoverageReports(graph, root, options),
  })
})
