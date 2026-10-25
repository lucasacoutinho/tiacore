import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import coverageLibrary from 'istanbul-lib-coverage'
import type { FileCoverageData } from 'istanbul-lib-coverage'
import { createInstrumenter } from 'istanbul-lib-instrument'
import { afterEach, describe, expect, test } from 'vitest'
import * as Effect from 'effect/Effect'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { selectedCoverage } from '../../../src/engine/coverage/files.ts'
import {
  coverageMapId,
  coverageTemplate,
  expandCoverageHits,
} from '../../../src/engine/state/coverage.ts'
import {
  mergedGraphCoverage,
  renderCoverageReports,
  writeCoverageReports,
} from '../../../src/engine/coverage/report.ts'
import {
  CoverageTemplates,
  instrumentationHash,
} from '../../../src/engine/coverage/templates.ts'
import { coverageThresholdFailures } from '../../../src/engine/coverage/thresholds.ts'
import type { TiaCoverageRuntime } from '../../../src/engine/coverage/types.ts'
import { installProbe } from '../../../src/probe/index.ts'
import type { ProbeCoverageMap } from '../../../src/probe/types.ts'
import { TiaIo } from '../../../src/wire/errors.ts'
import { legacy } from '../../support/legacy.ts'

const old = await legacy<{
  writeCoverageReports: (
    graph: unknown,
    root: string,
    options: TiaCoverageRuntime,
  ) => { files: number; thresholdFailures: unknown[]; warnings: string[] }
}>('integrations/coverage/report.js')

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

const COVERAGE_VARIABLE = '__tiacore_unit_coverage__'
const globals = globalThis as unknown as Record<string, unknown>

afterEach(() => {
  delete globals[COVERAGE_VARIABLE]
  delete globals['__tiacore_unit_call__']
})

const live = (): ProbeCoverageMap | undefined =>
  globals[COVERAGE_VARIABLE] as ProbeCoverageMap | undefined

const call = (value: number): void => {
  const fn = globals['__tiacore_unit_call__'] as (v: number) => number
  fn(value)
}

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

/** One test window over the file, as the setup file would take it. */
function testWindow() {
  const probe = installProbe(live)
  probe.beginTest('t')
  call(2)
  return probe.endTest('t')
}

function payload(unusedFunctions: number): string {
  load('/project/src/a.js', unusedFunctions)
  const window = testWindow()
  delete globals[COVERAGE_VARIABLE]
  return JSON.stringify(window.coverage).replace(/"hash":"[0-9a-f]+"/u, '')
}

function recordTwice(root: string) {
  const templates = load(`${root}/src/a.js`, 1)
  const { coverage } = testWindow()
  delete globals[COVERAGE_VARIABLE]
  const first = templates.record(root, coverage)
  const second = templates.record(root, coverage)
  return { first, maps: templates.maps([first, second]), second }
}

const expected = (
  counters: Record<string, number> | undefined,
  earlier: Record<string, number> | undefined,
) =>
  Object.fromEntries(
    Object.entries(counters ?? {}).map(([key, count]) => [
      key,
      count - (earlier?.[key] ?? 0),
    ]),
  )

describe('coverage templates', () => {
  test('rebuild the exact Istanbul delta from advanced counters', () => {
    const templates = load('/project/src/a.js', 3)
    const before = structuredClone(live()?.['/project/src/a.js'])
    const probe = installProbe(live)
    probe.beginTest('t')
    call(2)
    const { coverage } = probe.endTest('t')
    const after = live()?.['/project/src/a.js']

    expect(templates.unknownFiles('/project', coverage)).toEqual([])
    const record = templates.record('/project', coverage)
    const hits = record['src/a.js']
    const template =
      hits === undefined ? undefined : templates.maps([record])[hits.map]
    if (
      hits === undefined ||
      template === undefined ||
      before === undefined ||
      after === undefined
    ) {
      throw new Error('the window recorded no file')
    }

    const rebuilt = expandCoverageHits(template, 'src/a.js', hits)
    expect(rebuilt.s).toEqual(expected(after.s, before.s))
    expect(rebuilt.f).toEqual(expected(after.f, before.f))
    expect(rebuilt.b).toEqual(
      Object.fromEntries(
        Object.entries(after.b ?? {}).map(([key, counts]) => [
          key,
          counts.map((count, index) => count - (before.b?.[key]?.[index] ?? 0)),
        ]),
      ),
    )
    expect(rebuilt.statementMap).toEqual(
      (after as unknown as FileCoverageData).statementMap,
    )
  })

  test('keep the per-test payload independent of static map size', () => {
    expect(payload(500)).toBe(payload(1))
  })

  test('name one content-addressed map per file across tests and checkouts', () => {
    const local = recordTwice('/project')
    const ci = recordTwice('/runner/work/project')

    expect(Object.keys(local.maps)).toEqual([local.first['src/a.js']?.map])
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

  test('read the first instrumentation hash and ignore code without one (COV-INST-02)', () => {
    expect(instrumentationHash('var hash = "ab12"; var hash = "ff"')).toBe(
      'ab12',
    )
    expect(instrumentationHash('var hash = "XYZ"')).toBeNull()
    expect(instrumentationHash('')).toBeNull()
  })

  test('register once per hash and drop unknown or outside-root counters (COV-INST-03/06/07)', () => {
    const templates = load('/project/src/a.js', 1)
    const window = testWindow()
    const first = templates.record('/project', window.coverage)
    expect(Object.keys(first)).toEqual(['src/a.js'])
    expect(templates.record('/other', window.coverage)).toEqual({})
    expect(templates.record('/project/src/a.js', window.coverage)).toEqual({})
    expect(
      templates.maps([first, { 'x.js': { b: {}, f: {}, map: 'nope', s: {} } }]),
    ).toEqual(templates.maps([first]))
    // The id is the digest of the zeroed template: same code, same id.
    const [id] = Object.keys(templates.maps([first]))
    const template = templates.maps([first])[id ?? '']
    if (template === undefined) throw new Error('no template')
    expect(id).toBe(coverageMapId(template))
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

  const two = coverageLibrary.createCoverageMap({
    '/project/src/a.ts': fileCoverage('/project/src/a.ts', [1, 0]),
    '/project/src/b.ts': fileCoverage('/project/src/b.ts', [1, 1]),
  })

  test('fails a glob threshold that matches no files (COV-THR-06)', () => {
    expect(
      coverageThresholdFailures(two, '/project', {
        'src/typo/**': { lines: 10 },
        'src/b.ts': { lines: 10 },
      }).map((failure) => failure.message),
    ).toEqual([
      'ERROR: Coverage threshold "src/typo/**" matches no files, so it cannot be met',
    ])
    expect(
      coverageThresholdFailures(two, '/project', {
        'nothing/*': { branches: -5 },
        perFile: true,
      }),
    ).toHaveLength(1)
  })

  test('ignores a glob set with no metrics and reserved keys (COV-THR-05)', () => {
    expect(
      coverageThresholdFailures(two, '/project', {
        'nothing/*': {},
        autoUpdate: true,
      }),
    ).toEqual([])
    expect(coverageThresholdFailures(two, '/project', null)).toEqual([])
  })

  test('lets 100 override explicit metrics and skips non-finite values (COV-THR-03)', () => {
    expect(
      coverageThresholdFailures(two, '/project', {
        100: true,
        lines: 0,
      }).map((failure) => failure.message),
    ).toHaveLength(3)
    expect(
      coverageThresholdFailures(two, '/project', {
        lines: Number.NaN,
        statements: Number.POSITIVE_INFINITY,
      }),
    ).toEqual([])
  })

  test('matches glob sets with picomatch defaults: a star skips dot directories (COV-THR-05)', () => {
    const hidden = coverageLibrary.createCoverageMap({
      '/project/.hidden/h.ts': fileCoverage('/project/.hidden/h.ts', [0, 0]),
    })
    // With dot matching the glob would find h.ts and fail the 90% bar; as in
    // 1.x it finds nothing, which COV-THR-06 now reports.
    expect(
      coverageThresholdFailures(hidden, '/project', {
        '*/*.ts': { lines: 90 },
      }).map((failure) => failure.message),
    ).toEqual([
      'ERROR: Coverage threshold "*/*.ts" matches no files, so it cannot be met',
    ])
  })
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-coverage-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function runtime(
  root: string,
  over: Partial<TiaCoverageRuntime> = {},
): TiaCoverageRuntime {
  return {
    clean: true,
    cleanOnRerun: true,
    enabled: true,
    exclude: [],
    include: null,
    reportOnFailure: false,
    reporters: [
      { name: 'json', options: {} },
      { name: 'lcovonly', options: {} },
      { name: 'text-summary', options: { file: 'summary.txt' } },
    ],
    reportsDirectory: join(root, 'coverage'),
    skipFull: false,
    thresholds: null,
    watermarks: {
      branches: [50, 80],
      functions: [50, 80],
      lines: [50, 80],
      statements: [50, 80],
    },
    ...over,
  }
}

const SOURCE = `export function pick(value) {
  if (value > 0) { return 'positive' }
  return value < 0 ? 'negative' : 'zero'
}
export function unused() { return 1 }
`

/** Instruments the files under `root` and runs `pick` with the given values. */
function recordGraph(
  root: string,
  runs: Record<string, number[]>,
): TiaRuntimeGraph {
  const templates = new CoverageTemplates()
  const variable = '__tiacore_report_coverage__'
  const testCoverage: TiaRuntimeGraph['testCoverage'] = {}
  for (const [id, values] of Object.entries(runs)) {
    delete globals[variable]
    const instrumenter = createInstrumenter({
      coverageVariable: variable,
      esModules: true,
    })
    const file = join(root, 'src/a.js')
    const code = instrumenter.instrumentSync(SOURCE, file)
    templates.register(code, instrumenter.lastFileCoverage())
    const body = code
      .replace('export function pick', 'function pick')
      .replace('export function unused', 'function unused')
    const pick = new Function(`${body}\nreturn pick`)() as (
      value: number,
    ) => string
    const probe = installProbe(
      () => globals[variable] as ProbeCoverageMap | undefined,
    )
    probe.beginTest(id)
    for (const value of values) pick(value)
    testCoverage[id] = templates.record(root, probe.endTest(id).coverage)
  }
  delete globals[variable]
  return {
    baseline: { sha: '', workingTree: {} },
    collectionCoverage: {},
    collectionFiles: {},
    complete: true,
    coverageComplete: true,
    coverageMaps: templates.maps(Object.values(testCoverage)),
    edges: {},
    fingerprint: 'fp',
    results: {},
    schema: 5,
    testCoverage,
    testEdges: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const options = (root: string) =>
  runtime(root, {
    include: ['src/**/*.js'],
    thresholds: { lines: 95, 'src/zero.js': { statements: 100 } },
  })

describe('coverage reports', () => {
  const files = { 'src/a.js': SOURCE, 'src/zero.js': 'export const z = 1\n' }

  test('sums records per file and map before expanding the shared template (COV-RPT-01)', () => {
    const root = project(files)
    const graph = recordGraph(root, { one: [1], two: [1, -1], three: [0] })
    const merged = mergedGraphCoverage(graph, root).fileCoverageFor(
      join(root, 'src/a.js'),
    )
    expect(merged.toSummary().statements.pct).toBeGreaterThan(50)
    const [id] = Object.keys(graph.coverageMaps)
    const template = graph.coverageMaps[id ?? '']
    // The shared template is never mutated by the merge.
    expect(Object.values(template?.s ?? {}).every((count) => count === 0)).toBe(
      true,
    )
  })

  test('writes reports identical to 1.x for the same graph (COV-RPT-04/06, differential)', () => {
    const rootA = project(files)
    const rootB = project(files)
    const graphA = recordGraph(rootA, { one: [1], two: [1, -1] })
    const graphB = recordGraph(rootB, { one: [1], two: [1, -1] })
    const current = renderCoverageReports(graphA, rootA, options(rootA))
    const previous = old.writeCoverageReports(graphB, rootB, options(rootB))
    expect(current).toEqual(previous)
    expect(current.files).toBe(2)
    expect(current.thresholdFailures).not.toEqual([])
    for (const name of ['coverage-final.json', 'lcov.info', 'summary.txt']) {
      const normalize = (root: string) =>
        readFileSync(join(root, 'coverage', name), 'utf8').replaceAll(
          root,
          '<root>',
        )
      expect(normalize(rootA)).toBe(normalize(rootB))
    }
  })

  test('throws for an unknown reporter, and the stage reports it as TiaIo (COV-RPT-05)', async () => {
    const root = project(files)
    const graph = recordGraph(root, { one: [1] })
    const broken = runtime(root, {
      reporters: [{ name: 'no-such-reporter', options: {} }],
    })
    expect(() => renderCoverageReports(graph, root, broken)).toThrow(
      'no-such-reporter',
    )
    const failure = await Effect.runPromise(
      Effect.flip(writeCoverageReports(graph, root, broken)),
    )
    expect(failure).toBeInstanceOf(TiaIo)
    expect(failure.message).toContain('no-such-reporter')
    const ok = await Effect.runPromise(
      writeCoverageReports(graph, root, runtime(root)),
    )
    expect(ok.files).toBe(1)
  })
})

function mapOf(root: string, paths: string[]) {
  return coverageLibrary.createCoverageMap(
    Object.fromEntries(
      paths.map((path) => [
        join(root, path),
        fileCoverage(join(root, path), [1, 1]),
      ]),
    ),
  )
}

describe('coverage file selection', () => {
  const files = {
    'src/a.js': 'export const a = 1\n',
    'src/broken.js': 'export const = \n',
    'src/skip.js': 'export const s = 1\n',
    'test/a.test.js': 'export const t = 1\n',
  }

  test('without include keeps existing instrumented files only (COV-OPT-02, COV-SEL-02)', () => {
    const root = project(files)
    const result = selectedCoverage(
      mapOf(root, ['src/a.js', 'src/gone.js']),
      root,
      runtime(root),
    )
    expect(result.coverage.files()).toEqual([join(root, 'src/a.js')])
    expect(result.warnings).toEqual([])
  })

  test('with include filters, excludes and adds unexecuted files as zero-hit (COV-SEL-01/03/04/05)', () => {
    const root = project(files)
    const result = selectedCoverage(
      mapOf(root, ['src/a.js', 'test/a.test.js']),
      root,
      runtime(root, {
        exclude: ['**/skip.js', 'test/**'],
        include: ['src/**'],
      }),
    )
    expect(result.coverage.files().toSorted()).toEqual(
      [join(root, 'src/a.js')].toSorted(),
    )
    // skip.js is excluded, broken.js fails to instrument and is reported.
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(
      /^TIA coverage could not include .*src\/broken\.js: /u,
    )
    const zero = selectedCoverage(
      mapOf(root, []),
      root,
      runtime(root, { exclude: ['**/broken.js'], include: ['src/**'] }),
    )
    expect(zero.coverage.files().toSorted()).toEqual(
      [join(root, 'src/a.js'), join(root, 'src/skip.js')].toSorted(),
    )
    expect(
      zero.coverage.fileCoverageFor(join(root, 'src/a.js')).toSummary()
        .statements.covered,
    ).toBe(0)
  })

  test('matches include patterns anywhere in the path and dotfiles (COV-SEL-01)', () => {
    const root = project({
      '.hidden/x.js': 'export const x = 1\n',
      'src/a.js': 'export const a = 1\n',
    })
    const result = selectedCoverage(
      mapOf(root, ['src/a.js']),
      root,
      runtime(root, { include: ['.hidden/**', 'a.js'] }),
    )
    expect(result.coverage.files().toSorted()).toEqual(
      [join(root, '.hidden/x.js'), join(root, 'src/a.js')].toSorted(),
    )
  })
})

describe('coverage map ids', () => {
  test('hash the canonical zeroed template (NF-MEM-06)', () => {
    const template = coverageTemplate(fileCoverage('/p/a.ts', [3, 4]))
    expect(template.s).toEqual({ 0: 0, 1: 0 })
    expect(template.b).toEqual({ 0: [0, 0] })
    expect(coverageMapId(template)).toMatch(/^[0-9a-f]{64}$/u)
    expect(coverageMapId(template)).toBe(
      coverageMapId(coverageTemplate(fileCoverage('/other/a.ts', [9, 9]))),
    )
  })
})
