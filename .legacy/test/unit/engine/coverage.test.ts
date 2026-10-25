import coverageLibrary from 'istanbul-lib-coverage'
import type { FileCoverageData } from 'istanbul-lib-coverage'
import { createInstrumenter } from 'istanbul-lib-instrument'
import { afterEach, describe, expect, test } from 'vitest'

import {
  coverageCounterDelta,
  executedFilesSince,
  mergeCoverageCounters,
  snapshotCoverage,
} from '../../../src/integrations/coverage/runtime.js'
import { expandCoverageHits } from '../../../src/engine/state/coverage.js'
import { CoverageTemplates } from '../../../src/integrations/coverage/templates.js'
import { coverageThresholdFailures } from '../../../src/integrations/coverage/thresholds.js'
import type { CoverageMapLike } from '../../../src/shared/types.js'

function location(line: number) {
  return {
    end: { column: 10, line },
    start: { column: 0, line },
  }
}

function fileCoverage(path: string, hits: [number, number]): FileCoverageData {
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

  test('captures only advanced counters and the instrumentation hash', () => {
    const coverage: CoverageMapLike = {
      '/project/src/a.ts': {
        b: { 0: [1, 0], 1: [2, 2] },
        branchMap: {},
        f: { 0: 1, 1: 5 },
        fnMap: {},
        hash: 'abc',
        path: '/project/src/a.ts',
        s: { 0: 1, 1: 0, 2: 7 },
        statementMap: {},
      },
      '/project/src/idle.ts': {
        hash: 'def',
        path: '/project/src/idle.ts',
        s: { 0: 3 },
      },
    }
    const baseline = snapshotCoverage(coverage)
    coverage['/project/src/a.ts']!.s![0] = 3
    coverage['/project/src/a.ts']!.s![1] = 1
    coverage['/project/src/a.ts']!.f![0] = 2
    coverage['/project/src/a.ts']!.b![0]![1] = 4

    expect(coverageCounterDelta(baseline, coverage)).toEqual({
      '/project/src/a.ts': {
        b: { 0: [0, 4] },
        f: { 0: 1 },
        hash: 'abc',
        s: { 0: 2, 1: 1 },
      },
    })
  })

  test('merges disjoint lifecycle counters without losing hits', () => {
    expect(
      mergeCoverageCounters(
        {
          '/project/src/a.ts': {
            b: { 0: [1, 0] },
            f: {},
            hash: 'h',
            s: { 0: 1 },
          },
        },
        {
          '/project/src/a.ts': {
            b: { 0: [2, 3], 1: [1] },
            f: { 0: 2 },
            hash: 'h',
            s: { 0: 2, 1: 3 },
          },
        },
      ),
    ).toEqual({
      '/project/src/a.ts': {
        b: { 0: [3, 3], 1: [1] },
        f: { 0: 2 },
        hash: 'h',
        s: { 0: 3, 1: 3 },
      },
    })
  })
})

const COVERAGE_VARIABLE = '__tiacore_unit_coverage__'
const globals = globalThis as typeof globalThis & {
  [COVERAGE_VARIABLE]?: CoverageMapLike
  __tiacore_unit_call__?: (value: number) => number
}

afterEach(() => {
  delete globals[COVERAGE_VARIABLE]
  delete globals.__tiacore_unit_call__
})

function load(path: string, unusedFunctions: number) {
  const instrumenter = createInstrumenter({
    coverageVariable: COVERAGE_VARIABLE,
  })
  const unused = Array.from(
    { length: unusedFunctions },
    (_, index) =>
      `function unused${index}(value) { return value ? ${index} : -${index} }`,
  ).join('\n')
  const code = instrumenter.instrumentSync(
    `function used(value) { return value > 0 ? value : -value }\n${unused}\nglobalThis.__tiacore_unit_call__ = used\n`,
    path,
  )
  const templates = new CoverageTemplates()
  templates.register(code, instrumenter.lastFileCoverage())
  new Function(code)()
  return templates
}

function payload(unusedFunctions: number): string {
  load('/project/src/a.js', unusedFunctions)
  const before = snapshotCoverage(globals[COVERAGE_VARIABLE])
  globals.__tiacore_unit_call__?.(2)
  const delta = coverageCounterDelta(before, globals[COVERAGE_VARIABLE])
  delete globals[COVERAGE_VARIABLE]
  return JSON.stringify(delta).replace(/"hash":"[0-9a-f]+"/, '')
}

function recordTwice(root: string) {
  const templates = load(`${root}/src/a.js`, 1)
  const before = snapshotCoverage(globals[COVERAGE_VARIABLE])
  globals.__tiacore_unit_call__?.(2)
  const delta = coverageCounterDelta(before, globals[COVERAGE_VARIABLE])
  delete globals[COVERAGE_VARIABLE]
  const first = templates.record(root, delta)
  const second = templates.record(root, delta)
  return { first, maps: templates.maps([first, second]), second }
}

describe('coverage templates', () => {
  test('rebuild the exact Istanbul delta from advanced counters', () => {
    const templates = load('/project/src/a.js', 3)
    const coverage = () => globals[COVERAGE_VARIABLE]
    const before = snapshotCoverage(coverage())
    const live = structuredClone(coverage()!['/project/src/a.js']!)

    globals.__tiacore_unit_call__?.(2)
    const after = coverage()!['/project/src/a.js']!
    const delta = coverageCounterDelta(before, coverage())

    expect(templates.unknownFiles('/project', delta)).toEqual([])
    const record = templates.record('/project', delta)
    const hits = record['src/a.js']!
    const template = templates.maps([record])[hits.map]!

    expect(expandCoverageHits(template, 'src/a.js', hits)).toEqual({
      b: Object.fromEntries(
        Object.entries(after.b!).map(([key, counts]) => [
          key,
          counts.map((count, index) => count - live.b![key]![index]!),
        ]),
      ),
      branchMap: live.branchMap,
      f: Object.fromEntries(
        Object.entries(after.f!).map(([key, count]) => [
          key,
          count - live.f![key]!,
        ]),
      ),
      fnMap: live.fnMap,
      path: 'src/a.js',
      s: Object.fromEntries(
        Object.entries(after.s!).map(([key, count]) => [
          key,
          count - live.s![key]!,
        ]),
      ),
      statementMap: live.statementMap,
    })
  })

  test('keep the per-test payload independent of static map size', () => {
    expect(payload(500)).toBe(payload(1))
  })

  test('name one content-addressed map per file across tests and checkouts', () => {
    const local = recordTwice('/project')
    const ci = recordTwice('/runner/work/project')

    expect(Object.keys(local.maps)).toEqual([local.first['src/a.js']!.map])
    expect(local.second).toEqual(local.first)
    expect(ci.first).toEqual(local.first)
    expect(ci.maps).toEqual(local.maps)
  })

  test('report project files whose instrumentation is unknown', () => {
    const templates = new CoverageTemplates()

    expect(
      templates.unknownFiles('/project', {
        '/elsewhere/b.js': { b: {}, f: {}, hash: 'missing', s: { 0: 1 } },
        '/project/src/a.js': { b: {}, f: {}, hash: 'missing', s: { 0: 1 } },
      }),
    ).toEqual(['/project/src/a.js'])
  })
})

describe('coverage thresholds', () => {
  test('uses percentages for positive values and uncovered counts for negative values', () => {
    const coverage = coverageLibrary.createCoverageMap({
      '/project/src/a.ts': fileCoverage('/project/src/a.ts', [1, 0]),
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
      '/project/src/a.ts': fileCoverage('/project/src/a.ts', [1, 0]),
      '/project/src/b.ts': fileCoverage('/project/src/b.ts', [1, 1]),
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
