import coverageLibrary from 'istanbul-lib-coverage'
import type { FileCoverageData } from 'istanbul-lib-coverage'
import { describe, expect, test } from 'vitest'

import {
  coverageDelta,
  executedFilesSince,
  mergeCoverageMaps,
  snapshotCoverage,
} from '../../../src/integrations/coverage/runtime.js'
import { coverageThresholdFailures } from '../../../src/integrations/coverage/thresholds.js'
import type { CoverageMapLike } from '../../../src/shared/types.js'

function fileCoverage(
  path: string,
  hits: [number, number],
): FileCoverageData {
  const location = (line: number) => ({
    end: { column: 10, line },
    start: { column: 0, line },
  })

  return {
    b: { 0: hits },
    branchMap: {
      0: {
        line: 1,
        loc: location(1),
        locations: [location(1), location(2)],
        type: 'if',
      },
    },
    f: { 0: hits[0] },
    fnMap: {
      0: {
        decl: location(1),
        line: 1,
        loc: location(1),
        name: 'example',
      },
    },
    path,
    s: { 0: hits[0], 1: hits[1] },
    statementMap: {
      0: location(1),
      1: location(2),
    },
  }
}

describe('coverage snapshots', () => {
  test('finds statement, function, and branch counter advances', () => {
    const coverage: CoverageMapLike = {
      '/project/src/a.ts': {
        path: '/project/src/a.ts',
        s: { 0: 0 },
        f: { 0: 0 },
        b: { 0: [0, 0] },
      },
      '/project/src/b.ts': {
        path: '/project/src/b.ts',
        s: { 0: 1 },
      },
    }
    const baseline = snapshotCoverage(coverage)

    coverage['/project/src/a.ts']!.s![0] = 1
    coverage['/project/src/b.ts']!.s![0] = 1

    expect(executedFilesSince(baseline, coverage)).toEqual([
      '/project/src/a.ts',
    ])

    const secondBaseline = snapshotCoverage(coverage)
    coverage['/project/src/a.ts']!.b![0]![1] = 1

    expect(executedFilesSince(secondBaseline, coverage)).toEqual([
      '/project/src/a.ts',
    ])
  })

  test('captures only the counter delta with Istanbul source metadata', () => {
    const coverage: CoverageMapLike = {
      '/project/src/a.ts': {
        b: { 0: [1, 0] },
        branchMap: {},
        f: { 0: 1 },
        fnMap: {},
        path: '/project/src/a.ts',
        s: { 0: 1, 1: 0 },
        statementMap: {},
      },
    }
    const baseline = snapshotCoverage(coverage)
    coverage['/project/src/a.ts']!.s![0] = 3
    coverage['/project/src/a.ts']!.s![1] = 1
    coverage['/project/src/a.ts']!.f![0] = 2
    coverage['/project/src/a.ts']!.b![0]![1] = 4

    expect(coverageDelta(baseline, coverage)).toEqual({
      '/project/src/a.ts': {
        b: { 0: [0, 4] },
        branchMap: {},
        f: { 0: 1 },
        fnMap: {},
        path: '/project/src/a.ts',
        s: { 0: 2, 1: 1 },
        statementMap: {},
      },
    })
  })

  test('merges disjoint lifecycle coverage without losing counters', () => {
    const first = fileCoverage('/project/src/a.ts', [1, 0])
    const second = fileCoverage('/project/src/a.ts', [2, 3])

    expect(
      mergeCoverageMaps(
        { [first.path]: first },
        { [second.path]: second },
      )[first.path],
    ).toMatchObject({
      b: { 0: [3, 3] },
      f: { 0: 3 },
      s: { 0: 3, 1: 3 },
    })
  })
})

describe('coverage thresholds', () => {
  test('uses percentages for positive values and uncovered counts for negative values', () => {
    const coverage = coverageLibrary.createCoverageMap({
      '/project/src/a.ts': fileCoverage(
        '/project/src/a.ts',
        [1, 0],
      ),
    })

    expect(
      coverageThresholdFailures(coverage, '/project', {
        branches: -0.5,
        functions: 100,
        lines: 51,
        statements: -1,
      }).map((failure) => failure.message),
    ).toEqual([
      'ERROR: Coverage for lines (50%) does not meet global threshold (51%)',
      'ERROR: Uncovered branches (1) exceed global threshold (0.5)',
    ])
  })

  test('supports per-file checks, glob sets, and the 100 shortcut', () => {
    const coverage = coverageLibrary.createCoverageMap({
      '/project/src/a.ts': fileCoverage(
        '/project/src/a.ts',
        [1, 0],
      ),
      '/project/src/b.ts': fileCoverage(
        '/project/src/b.ts',
        [1, 1],
      ),
    })

    const perFile = coverageThresholdFailures(coverage, '/project', {
      lines: 60,
      perFile: true,
    })
    expect(perFile.map((failure) => failure.message)).toEqual([
      'ERROR: Coverage for lines (50%) does not meet global threshold (60%) for src/a.ts',
    ])

    const glob = coverageThresholdFailures(coverage, '/project', {
      'src/a.ts': { 100: true },
    })
    expect(glob.map((failure) => failure.message)).toEqual([
      'ERROR: Coverage for lines (50%) does not meet "src/a.ts" threshold (100%)',
      'ERROR: Coverage for statements (50%) does not meet "src/a.ts" threshold (100%)',
      'ERROR: Coverage for branches (50%) does not meet "src/a.ts" threshold (100%)',
    ])
  })
})
