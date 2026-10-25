import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import type {
  TiaVerificationReceipt,
  TiaVerificationSnapshot,
} from '../../src/core/verification.ts'
import {
  cleanupProjects,
  createFixtureProject,
  executions,
  packageRoot,
  readGraph,
  resetExecutions,
  runCommand,
  runVitest,
} from '../support/integration-project.ts'

// A project that tests with @effect/vitest: it.effect, it.live, a scoped
// resource, it.prop, layer() in each of its forms and detached fibers. The
// fixture gives every test its own source modules, so a source edit has one
// expected selection. Tiacore attributes coverage to the test whose window is
// open when code runs (hook markers, src/runners/vitest/setup.ts); these tests
// pin what that means for Effect's runtime.

interface Case {
  /** The line the test body appends to executions.log. */
  readonly label: string
  /** The full name Vitest reports. */
  readonly name: string
}

const catalog = {
  effect: { label: 'effect', name: 'it.effect' },
  live: { label: 'live', name: 'it.live' },
  scoped: { label: 'scoped', name: 'it.effect with a scoped resource' },
  prop: { label: 'prop', name: 'it.prop' },
  effectProp: { label: 'effect-prop', name: 'it.effect.prop' },
  namedA: { label: 'named-a', name: 'layer(L)(name, f) > named layer a' },
  namedB: { label: 'named-b', name: 'layer(L)(name, f) > named layer b' },
  unnamedA: { label: 'unnamed-a', name: 'unnamed layer a' },
  unnamedB: { label: 'unnamed-b', name: 'unnamed layer b' },
  outer: {
    label: 'method-outer',
    name: 'it.layer(L)(name, f) > outer layer case',
  },
  inner: {
    label: 'method-inner',
    name: 'it.layer(L)(name, f) > inner layer case',
  },
  concurrentA: {
    label: 'concurrent-a',
    name: 'layer(L, { concurrent }) > concurrent layer a',
  },
  concurrentB: {
    label: 'concurrent-b',
    name: 'layer(L, { concurrent }) > concurrent layer b',
  },
  inside: {
    label: 'detached-inside',
    name: 'detached fiber finishes inside the test',
  },
  between: {
    label: 'detached-after',
    name: 'detached fiber that finishes between tests > detached fiber finishes after the test body',
  },
  forker: {
    label: 'detached-fork',
    name: 'detached fiber finishes during a later test',
  },
  neighbour: {
    label: 'detached-neighbour',
    name: 'test that is running while the detached fiber finishes',
  },
} as const satisfies Record<string, Case>

type CaseKey = keyof typeof catalog

const everyCase = Object.keys(catalog).filter(
  (key): key is CaseKey => key in catalog,
)
const detachedFile: CaseKey[] = ['inside', 'between', 'forker', 'neighbour']
const concurrentFile: CaseKey[] = ['concurrentA', 'concurrentB']

const cli = join(packageRoot, 'dist/entries/cli.js')
const vitestBin = join(packageRoot, 'node_modules/vitest/vitest.mjs')
const temporaryDirectories: string[] = []

let recorded = ''
let recordedGraph: TiaRuntimeGraph
const idByName = new Map<string, string>()

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function idOf(key: CaseKey): string {
  const id = idByName.get(catalog[key].name)
  if (id === undefined)
    throw new Error(`no recorded test: ${catalog[key].name}`)
  return id
}

function idsOf(keys: readonly CaseKey[]): string[] {
  return keys.map(idOf).sort()
}

function edgeFiles(key: CaseKey): readonly string[] {
  return recordedGraph.testEdges[idOf(key)]?.files ?? []
}

function labelsOf(keys: readonly CaseKey[]): string[] {
  return [...new Set(keys.map((key) => catalog[key].label))].sort()
}

/** A private copy of the recorded project: its repository, graph and links. */
function copyRecorded(): string {
  const root = join(temporaryDirectory('tiacore-effect-copy-'), 'project')
  cpSync(recorded, root, { recursive: true, verbatimSymlinks: true })
  resetExecutions(root)
  return root
}

function touch(root: string, path: string): void {
  const file = join(root, path)
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n`)
}

interface SelectiveRun {
  readonly executedTestIds: string[]
  readonly labels: string[]
  readonly plan: TiaVerificationSnapshot['plan']
}

/** Runs Vitest once and reads which tests the run executed and which it replayed. */
function runSelective(root: string): SelectiveRun {
  const directory = temporaryDirectory('tiacore-effect-snapshot-')
  const run = runVitest(root, ['run'], 120_000, {
    TIA_VERIFICATION_DIRECTORY: directory,
    TIA_VERIFICATION_PHASE: 'selective',
  })
  expect(run.status, run.output).toBe(0)
  const files = readdirSync(join(directory, 'selective'))
  expect(files).toHaveLength(1)
  const snapshot: TiaVerificationSnapshot = JSON.parse(
    readFileSync(join(directory, 'selective', files[0] ?? ''), 'utf8'),
  )
  return {
    executedTestIds: snapshot.executedTestIds,
    labels: [...new Set(executions(root))].sort(),
    plan: snapshot.plan,
  }
}

function selection(run: SelectiveRun) {
  return { ids: run.executedTestIds, labels: run.labels }
}

function selectionOf(keys: readonly CaseKey[]) {
  return { ids: idsOf(keys), labels: labelsOf(keys) }
}

beforeAll(async () => {
  recorded = createFixtureProject('effect-vitest')
  // The fixture imports effect and @effect/vitest; the shared helper links
  // only what the other fixtures need.
  mkdirSync(join(recorded, 'node_modules/@effect'), { recursive: true })
  for (const dependency of ['@effect/vitest', 'effect']) {
    symlinkSync(
      join(packageRoot, 'node_modules', dependency),
      join(recorded, 'node_modules', dependency),
    )
  }
  const run = runVitest(recorded, ['run'], 120_000)
  if (run.status !== 0) {
    throw new Error(`recording run failed\n${run.output}`)
  }
  recordedGraph = await readGraph(recorded)
  for (const result of Object.values(recordedGraph.results)) {
    idByName.set(result.fullName, result.id)
  }
}, 180_000)

afterAll(() => {
  cleanupProjects()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('recording an @effect/vitest project', () => {
  test('runs and records every kind of Effect test', () => {
    expect([...new Set(executions(recorded))].sort()).toEqual(
      labelsOf(everyCase),
    )
    expect(Object.keys(recordedGraph.results)).toHaveLength(everyCase.length)
    expect(idByName.size).toBe(everyCase.length)
    for (const key of everyCase) {
      expect(recordedGraph.results[idOf(key)]?.state).toBe('passed')
    }
  })

  test('keeps per-test edges for tests that run one at a time', () => {
    expect(edgeFiles('effect')).toContain('src/basic-effect.ts')
    expect(edgeFiles('effect')).not.toContain('src/basic-live.ts')
    expect(edgeFiles('scoped')).toContain('src/basic-scoped.ts')
    expect(edgeFiles('prop')).toContain('src/basic-prop.ts')
    expect(edgeFiles('namedA')).toContain('src/named-a.ts')
    expect(edgeFiles('namedA')).not.toContain('src/named-b.ts')
  })

  test('falls back to the whole file for a concurrent layer block', () => {
    for (const key of concurrentFile) {
      expect(recordedGraph.testEdges[idOf(key)]).toBeUndefined()
    }
    expect(recordedGraph.edges['test/layer-concurrent.test.ts']).toEqual(
      expect.arrayContaining(['src/concurrent-a.ts', 'src/concurrent-b.ts']),
    )
  })
})

describe('selection after a source edit', () => {
  // Each case starts from a copy of the same recorded project.
  const cases: ReadonlyArray<
    readonly [edit: string, selected: readonly CaseKey[]]
  > = [
    // Effect tests, live tests, a scoped resource and both property forms:
    // the body runs inside the test window.
    ['src/basic-effect.ts', ['effect']],
    ['src/basic-live.ts', ['live']],
    ['src/basic-scoped.ts', ['scoped']],
    ['src/basic-prop.ts', ['prop']],
    ['src/basic-effect-prop.ts', ['effectProp']],
    // A named layer block builds the layer in a beforeAll hook, so what its
    // construction runs belongs to every test of the file.
    ['src/named-a.ts', ['namedA']],
    ['src/named-b.ts', ['namedB']],
    ['src/named-build.ts', ['namedA', 'namedB']],
    // An unnamed layer block builds the layer in a beforeEach hook that runs
    // before the body window opens.
    ['src/unnamed-a.ts', ['unnamedA']],
    ['src/unnamed-b.ts', ['unnamedB']],
    ['src/unnamed-build.ts', ['unnamedA', 'unnamedB']],
    // The method form of a named block, with an unnamed nested block.
    ['src/method-outer.ts', ['outer']],
    ['src/method-inner.ts', ['inner']],
    ['src/method-outer-build.ts', ['outer', 'inner']],
    ['src/method-inner-build.ts', ['outer', 'inner']],
    // Tests of a concurrent block overlap: whole-file selection.
    ['src/concurrent-a.ts', concurrentFile],
    ['src/concurrent-b.ts', concurrentFile],
    // A detached fiber that finishes before the test body ends.
    ['src/detached-inside.ts', ['inside']],
    // A detached fiber that finishes after the body, between two tests: the
    // coverage belongs to no test, so every test of the file reruns.
    ['src/detached-after.ts', detachedFile],
    // A detached fiber that finishes while a later test runs: the later test
    // owns the coverage (see the dedicated test below).
    ['src/detached-later.ts', ['neighbour']],
    ['src/detached-neighbour.ts', ['neighbour']],
    // A changed test file reruns all of its tests.
    ['test/basic.test.ts', ['effect', 'live', 'scoped', 'prop', 'effectProp']],
  ]

  test.each(cases)('editing %s selects %j', (edit, selected) => {
    const root = copyRecorded()
    touch(root, edit)

    const run = runSelective(root)

    expect(selection(run)).toEqual(selectionOf(selected))
    expect(run.plan.mode).toBe('replay')
    expect(run.plan.changedFiles).toEqual([edit])
    expect(run.plan.replayedTests).toBe(everyCase.length - selected.length)
  })

  test('selects the whole file, not single tests, for a concurrent block', () => {
    const root = copyRecorded()
    touch(root, 'src/concurrent-a.ts')

    const run = runSelective(root)

    expect(run.plan.wholeTestFiles).toEqual(['test/layer-concurrent.test.ts'])
    expect(run.plan.affectedTestIds).toEqual([])
  })

  test('an unknown file runs the whole suite', () => {
    const root = copyRecorded()
    writeFileSync(join(root, 'notes.txt'), 'not a dependency of any test\n')

    const run = runSelective(root)

    expect(selection(run)).toEqual(selectionOf(everyCase))
    expect(run.plan.mode).toBe('record')
  })
})

describe('detached fibers', () => {
  test('attribute late coverage to the window it ran in, not to the forking test', () => {
    // The fiber forked by `forker` touched src/detached-later.ts while
    // `neighbour` was running. The forker's outcome was settled before that,
    // so only the test that was running can be affected by the code.
    expect(edgeFiles('neighbour')).toContain('src/detached-later.ts')
    expect(edgeFiles('forker')).not.toContain('src/detached-later.ts')
    // Coverage between two windows is collection coverage, shared by the file.
    for (const key of detachedFile) {
      expect(edgeFiles(key)).toContain('src/detached-after.ts')
    }
    // Inside the window it belongs to the test alone.
    expect(edgeFiles('inside')).toContain('src/detached-inside.ts')
    for (const key of detachedFile.filter((other) => other !== 'inside')) {
      expect(edgeFiles(key)).not.toContain('src/detached-inside.ts')
    }
  })

  // Known limitation. Replaying the forking test removes the fiber from the
  // run, so the neighbour no longer touches the module and its new evidence
  // drops the edge. The module is then unknown to the graph, and the next
  // edit falls back to a full run. The fallback is sound; the precision is
  // lost until that run records the fiber again.
  test('lose a module that only a replayed test spawns until the next full run', () => {
    const root = copyRecorded()

    touch(root, 'src/detached-later.ts')
    expect(selection(runSelective(root))).toEqual(selectionOf(['neighbour']))
    resetExecutions(root)

    touch(root, 'src/detached-later.ts')
    const rerun = runSelective(root)

    expect(rerun.plan.mode).toBe('record')
    expect(rerun.plan.reason).toContain(
      'changed file is unknown to the graph: src/detached-later.ts',
    )
    expect(selection(rerun)).toEqual(selectionOf(everyCase))
  })
})

describe('selection stays exact when selective runs update the graph', () => {
  test('layer construction stays a dependency of every test of its block', () => {
    const root = copyRecorded()

    touch(root, 'src/named-a.ts')
    expect(selection(runSelective(root))).toEqual(selectionOf(['namedA']))
    resetExecutions(root)

    touch(root, 'src/named-build.ts')
    expect(selection(runSelective(root))).toEqual(
      selectionOf(['namedA', 'namedB']),
    )
    resetExecutions(root)

    touch(root, 'src/unnamed-b.ts')
    expect(selection(runSelective(root))).toEqual(selectionOf(['unnamedB']))
    resetExecutions(root)

    touch(root, 'src/unnamed-build.ts')
    expect(selection(runSelective(root))).toEqual(
      selectionOf(['unnamedA', 'unnamedB']),
    )
  })

  test('a nested layer is rebuilt for the test that uses it after a run that replayed it', () => {
    const root = copyRecorded()

    touch(root, 'src/method-outer.ts')
    expect(selection(runSelective(root))).toEqual(selectionOf(['outer']))
    resetExecutions(root)

    // The previous run replayed the inner test, so the inner layer was not
    // built. Its construction must still select the test that uses it.
    touch(root, 'src/method-inner-build.ts')
    const run = runSelective(root)
    expect(run.executedTestIds).toContain(idOf('inner'))
    expect(run.labels).toContain(catalog.inner.label)
  })
})

interface VerifyRun {
  readonly output: string
  readonly receipt: TiaVerificationReceipt
  readonly status: number | null
}

/** Edits `paths`, then runs `tiacore verify -- <vitest command>` over the copy. */
function verifyAfterEditing(paths: readonly string[]): VerifyRun {
  const root = copyRecorded()
  for (const path of paths) touch(root, path)
  const result = runCommand(
    root,
    process.execPath,
    [
      cli,
      'verify',
      '--output',
      'verification.json',
      '--',
      process.execPath,
      vitestBin,
      'run',
    ],
    240_000,
  )
  const receipt: TiaVerificationReceipt = JSON.parse(
    readFileSync(join(root, 'verification.json'), 'utf8'),
  )
  return { output: result.output, receipt, status: result.status }
}

describe('tiacore verify', () => {
  const verified: ReadonlyArray<
    readonly [
      description: string,
      edits: readonly string[],
      selected: readonly CaseKey[],
    ]
  > = [
    [
      'effect, flat and nested layers and a concurrent block',
      [
        'src/basic-effect.ts',
        'src/named-b.ts',
        'src/unnamed-build.ts',
        'src/method-inner.ts',
        'src/concurrent-b.ts',
      ],
      ['effect', 'namedB', 'unnamedA', 'unnamedB', 'inner', ...concurrentFile],
    ],
    [
      'live, scoped, property tests and detached fibers',
      [
        'src/basic-live.ts',
        'src/basic-scoped.ts',
        'src/basic-prop.ts',
        'src/basic-effect-prop.ts',
        'src/detached-inside.ts',
        'src/detached-after.ts',
      ],
      ['live', 'scoped', 'prop', 'effectProp', ...detachedFile],
    ],
  ]

  test.each(verified)(
    'verifies a selective run after editing %s',
    (_description, edits, selected) => {
      const { output, receipt, status } = verifyAfterEditing(edits)

      expect(status, output).toBe(0)
      expect(receipt).toMatchObject({
        accuracy: {
          executedTests: selected.length,
          expectedTests: selected.length,
          falseNegativeRate: 0,
          missedTests: 0,
          precision: 1,
          unnecessaryTests: 0,
        },
        issues: [],
        success: true,
        verified: true,
      })
      expect(receipt.runners).toHaveLength(1)
      expect(receipt.runners[0]?.runner).toMatch(/^vitest:/u)
      expect(receipt.runners[0]?.selection).toMatchObject({
        executedTestIds: idsOf(selected),
        expectedTestIds: idsOf(selected),
        falseNegativeRate: 0,
        missedTestIds: [],
        unnecessaryTestIds: [],
      })
      expect(receipt.phases.selective.metrics).toEqual([
        expect.objectContaining({
          executedTests: selected.length,
          mode: 'replay',
          replayedTests: everyCase.length - selected.length,
        }),
      ])
      expect(receipt.phases.full.metrics).toEqual([
        expect.objectContaining({ executedTests: everyCase.length }),
      ])
    },
  )

  // The unnamed nested layer builds in a beforeEach hook of the inner test,
  // before the body window opens, so its construction is collection evidence
  // of the file. A run that replays the inner test does not build it; the
  // graph update keeps the file's previous collection evidence for partially
  // run files (proofs/Tia/Update.lean), so the selective graph still matches
  // the full one.
  test('verifies a run that replays an unnamed layer block', () => {
    const { receipt, status } = verifyAfterEditing(['src/method-outer.ts'])

    expect(receipt.issues).toEqual([])
    expect(status).toBe(0)
    expect(receipt.verified).toBe(true)
    expect(receipt.accuracy).toMatchObject({
      executedTests: 1,
      expectedTests: 1,
      falseNegativeRate: 0,
      missedTests: 0,
    })
    expect(receipt.runners[0]?.selection?.executedTestIds).toEqual(
      idsOf(['outer']),
    )
  })
})
