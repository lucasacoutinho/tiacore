import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import coverageLibrary from 'istanbul-lib-coverage'
import reportLibrary from 'istanbul-lib-report'
import reports from 'istanbul-reports'

import { projectRelative } from '../shared/paths.js'
import type {
  TiaCoverageMap,
  TiaCoverageRuntime,
  TiaRuntimeGraph,
} from '../shared/types.js'
import {
  coverageThresholdFailures,
  type CoverageThresholdFailure,
} from './thresholds.js'
import { selectedCoverage } from './files.js'

export interface CoverageReportResult {
  files: number
  thresholdFailures: CoverageThresholdFailure[]
  warnings: string[]
}

export function portableCoverageMap(
  root: string,
  coverage: TiaCoverageMap,
): TiaCoverageMap {
  const portable: TiaCoverageMap = {}

  for (const [key, value] of Object.entries(coverage)) {
    const file = projectRelative(root, value.path || key)
    if (file === null || file === '') {
      continue
    }

    portable[file] = {
      ...structuredClone(value),
      path: file,
    }
  }

  return portable
}

function absoluteCoverageMap(
  root: string,
  coverage: TiaCoverageMap,
): TiaCoverageMap {
  return Object.fromEntries(
    Object.entries(coverage).map(([key, value]) => {
      const path = resolve(root, value.path || key)
      return [
        path,
        {
          ...structuredClone(value),
          path,
        },
      ]
    }),
  )
}

export function mergedGraphCoverage(
  graph: TiaRuntimeGraph,
  root: string,
): ReturnType<typeof coverageLibrary.createCoverageMap> {
  const merged = coverageLibrary.createCoverageMap()

  for (const coverage of Object.values(graph.collectionCoverage)) {
    merged.merge(absoluteCoverageMap(root, coverage))
  }
  for (const coverage of Object.values(graph.testCoverage)) {
    merged.merge(absoluteCoverageMap(root, coverage))
  }

  return merged
}

export function writeCoverageReports(
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
    reports.create(reporter.name as never, {
      projectRoot: root,
      skipFull: options.skipFull,
      ...reporter.options,
    } as never).execute(context)
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
