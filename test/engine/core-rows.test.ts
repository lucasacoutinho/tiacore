import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

import type { RunPlan } from '../../src/core/runtime.ts'
import type {
  TiaReplayAdapter,
  TiaReplayCompleteEvent,
  TiaReplayedTestEvent,
} from '../../src/core/replay.ts'
import { TiaCore, type TiaObservation } from '../../src/entries/core.ts'
import { CoreRun } from '../../src/engine/core-run.ts'
import {
  notifyRunComplete,
  notifyRunStart,
  replayedResults,
  replayRunEvent,
} from '../../src/engine/replay.ts'
import { runPromise } from '../../src/host/runtime.ts'
import { beginRun } from '../../src/engine/lifecycle.ts'
import { initRepository } from '../support/runner-project.ts'
import { EngineLive } from './support/layers.ts'
import { baseGraph } from './support/graphs.ts'

// The runner-neutral core: options, fingerprints, run lifecycle, commit,
// replay and the start of a run.

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-core-rows-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  for (const name of ['a', 'b']) {
    writeFileSync(join(root, `src/${name}.ts`), `export const ${name} = 1\n`)
    writeFileSync(join(root, `test/${name}.test.ts`), `// ${name}\n`)
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, '.gitignore'), '.tia/\n')
  initRepository(root)
  return root
}

function observation(name: string, extra: object = {}): TiaObservation {
  return {
    file: `test/${name}.test.ts`,
    files: [`src/${name}.ts`],
    fullName: `${name} case`,
    id: `${name}-case`,
    state: 'passed',
    ...extra,
  }
}

const OPTIONS = { files: ['test/**/*.test.ts'], log: false, runner: 'rows' }

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    affectedTestIds: [],
    affectedTests: [],
    baseline: { origin: 'local', reason: 'r', sha: 'abc', source: 'git' },
    changedFiles: [],
    decisions: [],
    graph: baseGraph(),
    mode: 'replay',
    reason: 'no affected test files',
    replayedTests: 2,
    wholeTestFiles: [],
    ...overrides,
  }
}

describe('replayedResults', () => {
  test('is empty unless the plan replays a graph', () => {
    expect(replayedResults(plan({ mode: 'record' }))).toEqual([])
    expect(replayedResults(plan({ graph: null }))).toEqual([])
  })

  test('keeps unaffected, unfailed results, skipped ones included, in id order', () => {
    const graph = baseGraph({
      results: {
        z: { file: 'test/z.test.ts', fullName: 'z', id: 'z', state: 'passed' },
        a: { file: 'test/a.test.ts', fullName: 'a', id: 'a', state: 'skipped' },
        failed: {
          file: 'test/f.test.ts',
          fullName: 'f',
          id: 'failed',
          state: 'failed',
        },
        affected: {
          file: 'test/c.test.ts',
          fullName: 'c',
          id: 'affected',
          state: 'passed',
        },
        whole: {
          file: 'test/w.test.ts',
          fullName: 'w',
          id: 'whole',
          state: 'passed',
        },
        Upper: {
          file: 'test/u.test.ts',
          fullName: 'u',
          id: 'Upper',
          state: 'passed',
        },
      },
    })
    const replayed = replayedResults(
      plan({
        affectedTestIds: ['affected'],
        graph,
        wholeTestFiles: ['test/w.test.ts'],
      }),
    )
    // UTF-16 code-unit order: uppercase sorts before lowercase.
    expect(replayed.map((result) => result.id)).toEqual(['Upper', 'a', 'z'])
  })

  test('the run event copies the plan and leaves the graph out', () => {
    const source = plan({ affectedTestIds: ['a'], wholeTestFiles: ['w'] })
    const event = replayRunEvent(source)
    expect(event).not.toHaveProperty('graph')
    expect(event).toMatchObject({
      affectedTestIds: ['a'],
      mode: 'replay',
      replayedTests: 2,
      wholeTestFiles: ['w'],
    })
    event.baseline.reason = 'mutated'
    expect(source.baseline.reason).toBe('r')
  })
})

describe('replay adapter notification', () => {
  test('calls adapters in order, skips missing methods, and survives failures', async () => {
    const calls: string[] = []
    const adapters: TiaReplayAdapter[] = [
      {
        onRunStart: () => {
          calls.push('first')
          throw new Error('sync boom')
        },
      },
      {},
      {
        onRunStart: async () => {
          calls.push('third')
          await Promise.resolve()
          throw new Error('async boom')
        },
      },
      {
        onRunStart: () => {
          calls.push('fourth')
        },
      },
    ]
    const warnings: string[] = []
    await notifyRunStart(adapters, plan(), (message) => warnings.push(message))
    expect(calls).toEqual(['first', 'third', 'fourth'])
    expect(warnings).toEqual([
      'TIA replay adapter onRunStart failed: sync boom',
      'TIA replay adapter onRunStart failed: async boom',
    ])
  })

  test('announces each cached result after the start, then lets the host follow', async () => {
    const events: string[] = []
    const adapter: TiaReplayAdapter = {
      onRunStart: () => void events.push('start'),
      onTestReplayed: (event) => void events.push(`adapter:${event.result.id}`),
    }
    await notifyRunStart(
      [adapter],
      plan({
        graph: baseGraph(),
        wholeTestFiles: [],
      }),
      () => {},
      async (result) => {
        events.push(`host:${result.id}`)
      },
    )
    expect(events).toEqual([
      'start',
      'adapter:a',
      'host:a',
      'adapter:b',
      'host:b',
    ])
  })

  test('completion sorts the executed files and warns about a failing adapter', async () => {
    const seen: TiaReplayCompleteEvent[] = []
    const warnings: string[] = []
    await notifyRunComplete(
      [
        { onRunComplete: (event) => void seen.push(event) },
        {
          onRunComplete: () => {
            throw new Error('late')
          },
        },
      ],
      plan(),
      {
        coverageReportDirectory: 'coverage',
        executedTestFiles: new Set(['test/b.test.ts', 'test/a.test.ts']),
      },
      (message) => warnings.push(message),
    )
    expect(seen[0]).toMatchObject({
      coverageReportDirectory: 'coverage',
      executedTestFiles: ['test/a.test.ts', 'test/b.test.ts'],
    })
    expect(warnings).toEqual(['TIA replay adapter onRunComplete failed: late'])
  })
})

describe('TiaCore adapter events', () => {
  test('emits start, one event per cached result, then completion after a commit', async () => {
    const root = project()
    const events: string[] = []
    const replayed: TiaReplayedTestEvent[] = []
    let complete: TiaReplayCompleteEvent | undefined
    const adapter: TiaReplayAdapter = {
      onRunComplete: (event) => {
        events.push('complete')
        complete = event
      },
      onRunStart: () => {
        events.push('start')
      },
      onTestReplayed: (event) => {
        events.push(`replayed:${event.result.id}`)
        replayed.push(event)
        event.result.state = 'failed'
      },
    }
    const recording = new TiaCore({ ...OPTIONS, root, replayAdapters: adapter })
    await recording.prepare()
    await recording.commit(
      [observation('a'), observation('b')],
      ['test/a.test.ts', 'test/b.test.ts'],
    )
    expect(events).toEqual(['start', 'complete'])
    expect(complete).toMatchObject({
      coverageReportDirectory: null,
      executedTestFiles: ['test/a.test.ts', 'test/b.test.ts'],
      mode: 'record',
    })

    events.length = 0
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')
    const replaying = new TiaCore({
      ...OPTIONS,
      root,
      replayAdapters: [adapter],
    })
    const replayPlan = await replaying.prepare()
    expect(events).toEqual(['start', 'replayed:b-case'])
    // The adapter mutated its copy; the stored result is untouched.
    expect(replayPlan.graph?.results['b-case']?.state).toBe('passed')
    expect(replaying.replayedResults()[0]?.state).toBe('passed')

    await replaying.commit([observation('a')], [])
    expect(events).toEqual(['start', 'replayed:b-case', 'complete'])
    expect(complete?.executedTestFiles).toEqual(['test/a.test.ts'])
    expect(replayed).toHaveLength(1)
  })

  test('a failing adapter warns and never aborts the run', async () => {
    const root = project()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const core = new TiaCore({
      ...OPTIONS,
      replayAdapters: [
        {
          onRunStart: () => {
            throw new Error('nope')
          },
        },
      ],
      root,
    })
    await core.prepare()
    expect(warn).toHaveBeenCalledWith(
      'TIA replay adapter onRunStart failed: nope',
    )
  })

  // No completion event when the commit is skipped.
  test('does not fire onRunComplete when the commit returns null', async () => {
    const root = project()
    const completions: string[] = []
    const core = new TiaCore({
      ...OPTIONS,
      replayAdapters: { onRunComplete: () => void completions.push('done') },
      root,
    })
    await core.prepare()
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')
    expect(await core.commit([observation('a')], ['test/a.test.ts'])).toBeNull()
    expect(completions).toEqual([])
  })
})

describe('TiaCore options and lifecycle', () => {
  test('reading the plan or committing before prepare throws', async () => {
    const core = new TiaCore({ ...OPTIONS, root: project() })
    expect(() => core.plan).toThrow('TIA core has not been prepared')
    await expect(core.commit([], [])).rejects.toThrow(
      'TIA core has not been prepared',
    )
  })

  test('applies the documented defaults and appends user excludes', () => {
    const root = project()
    const core = new TiaCore({
      ...OPTIONS,
      exclude: ['generated/**'],
      include: ['lib/**'],
      root,
    })
    expect(core.root).toBe(root)
    expect(core.cacheDir).toBe(join(root, '.tia', 'rows'))
    expect(core.options.exclude).toEqual(
      expect.arrayContaining(['generated/**', '**/node_modules/**']),
    )
    expect(core.options.exclude.at(-1)).toBe('generated/**')
    expect(core.options.exclude.length).toBeGreaterThan(2)
    expect(core.options.include).toEqual(['lib/**'])
    expect(core.options).toMatchObject({
      ignoreChanges: [],
      log: false,
      onUnknownChange: 'full',
      replayAdapters: [],
    })
    expect(
      new TiaCore({ ...OPTIONS, replayAdapters: {}, root }).options
        .replayAdapters,
    ).toEqual([{}])
  })

  test('files, fingerprint, testFiles and the runner name decide compatibility', async () => {
    const root = project()
    const recording = new TiaCore({ ...OPTIONS, root, testFiles: ['test/**'] })
    await recording.prepare()
    await recording.commit([observation('a')], ['test/a.test.ts'])

    const same = await new TiaCore({
      ...OPTIONS,
      root,
      testFiles: ['test/**'],
    }).prepare()
    expect(same.mode).toBe('replay')

    // `files` is never expanded, only fingerprinted: a pattern that matches
    // nothing is accepted, and changing it invalidates the graph.
    for (const change of [
      { files: ['no/such/**/*.test.ts'] },
      { fingerprint: 'adapter-v2' },
      { testFiles: ['test/a.test.ts'] },
    ]) {
      const changed = await new TiaCore({
        ...OPTIONS,
        root,
        testFiles: ['test/**'],
        ...change,
      }).prepare()
      expect(changed, JSON.stringify(change)).toMatchObject({
        mode: 'record',
        reason: 'project structure changed',
      })
    }
    const other = await new TiaCore({
      ...OPTIONS,
      root,
      runner: 'other',
      testFiles: ['test/**'],
    }).prepare()
    expect(other).toMatchObject({
      mode: 'record',
      reason: 'no compatible graph found',
    })
  })

  test('stamps the saved graph, stores failures, and re-stamps an empty commit', async () => {
    const root = project()
    const recording = new TiaCore({ ...OPTIONS, root })
    await recording.prepare()
    const saved = await recording.commit(
      [observation('a', { state: 'failed' }), observation('b')],
      ['test/a.test.ts', 'test/b.test.ts'],
    )
    expect(saved).toMatchObject({
      complete: true,
      coverageComplete: false,
    })
    expect(saved).not.toHaveProperty('partition')
    expect(saved?.results['a-case']?.state).toBe('failed')
    expect(Date.parse(saved?.updatedAt ?? '')).not.toBeNaN()

    const replaying = new TiaCore({ ...OPTIONS, root })
    const replayPlan = await replaying.prepare()
    // The stored failure reruns.
    expect(replayPlan.affectedTestIds).toEqual(['a-case'])

    await new Promise((resolve) => setTimeout(resolve, 5))
    const quiet = new TiaCore({ ...OPTIONS, root })
    await quiet.prepare()
    const first = await quiet.commit([observation('a')], ['test/a.test.ts'])
    const stamped = new TiaCore({ ...OPTIONS, root })
    const stampedPlan = await stamped.prepare()
    expect(stampedPlan.affectedTestIds).toEqual([])
    const second = await stamped.commit([], [])
    expect(second).not.toBeNull()
    expect(second?.fingerprint).toBe(first?.fingerprint)
    expect(Date.parse(second?.updatedAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(first?.updatedAt ?? ''),
    )
  })

  test('returns null without logging when another writer committed an incompatible graph', async () => {
    const root = project()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const first = new TiaCore({ ...OPTIONS, root })
    const second = new TiaCore({ ...OPTIONS, fingerprint: 'divergent', root })
    await first.prepare()
    await second.prepare()
    expect(
      await first.commit([observation('a')], ['test/a.test.ts']),
    ).not.toBeNull()
    expect(
      await second.commit([observation('b')], ['test/b.test.ts']),
    ).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  test('a fresh run purges the stored state when it plans', async () => {
    const root = project()
    const recording = new TiaCore({ ...OPTIONS, root })
    await recording.prepare()
    await recording.commit([observation('a')], ['test/a.test.ts'])
    expect(existsSync(join(root, '.tia/rows/state.json'))).toBe(true)

    const fresh = new TiaCore({ ...OPTIONS, fresh: true, root })
    const freshPlan = await fresh.prepare()
    expect(freshPlan).toMatchObject({
      mode: 'record',
      reason: 'fresh graph requested',
    })
    expect(freshPlan.baseline.reason).toBe('fresh graph requested')
    expect(existsSync(join(root, '.tia/rows/state.json'))).toBe(false)
  })

  test('writes a verification snapshot only when both variables are set', async () => {
    const root = project()
    const directory = join(root, 'verification')
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', directory)
    vi.stubEnv('TIA_VERIFICATION_PHASE', undefined)
    await expect(new TiaCore({ ...OPTIONS, root }).prepare()).rejects.toThrow(
      'must be set together',
    )

    vi.stubEnv('TIA_VERIFICATION_PHASE', 'full')
    const core = new TiaCore({ ...OPTIONS, root })
    await core.prepare()
    expect(
      await core.commit([observation('a')], ['test/a.test.ts']),
    ).not.toBeNull()
    expect(readdirSync(directory)).toEqual(['full'])
    expect(readdirSync(join(directory, 'full'))).toHaveLength(1)
  })

  test('a bad verification phase fails the run at prepare and saves no graph', async () => {
    const root = project()
    const directory = join(root, 'verification')
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', directory)
    vi.stubEnv('TIA_VERIFICATION_PHASE', 'sideways')
    const core = new TiaCore({ ...OPTIONS, root })
    await expect(core.prepare()).rejects.toThrow(
      'TIA_VERIFICATION_PHASE must be selective or full',
    )
    await expect(
      core.commit([observation('a')], ['test/a.test.ts']),
    ).rejects.toThrow('TIA core has not been prepared')
    expect(existsSync(join(root, '.tia/rows/state.json'))).toBe(false)
    expect(existsSync(directory)).toBe(false)
  })

  test('a commit writes to the verification target that prepare read', async () => {
    const root = project()
    const directory = join(root, 'verification')
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', directory)
    vi.stubEnv('TIA_VERIFICATION_PHASE', 'selective')
    const core = new TiaCore({ ...OPTIONS, root })
    await core.prepare()
    vi.stubEnv('TIA_VERIFICATION_PHASE', 'sideways')
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', join(root, 'elsewhere'))
    expect(
      await core.commit([observation('a')], ['test/a.test.ts']),
    ).not.toBeNull()
    expect(readdirSync(directory)).toEqual(['selective'])
    expect(existsSync(join(root, 'elsewhere'))).toBe(false)
  })

  test('a run given its own environment ignores the process environment', async () => {
    const root = project()
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', join(root, 'verification'))
    vi.stubEnv('TIA_VERIFICATION_PHASE', 'sideways')
    const core = new CoreRun({ ...OPTIONS, root }, {})
    await runPromise(core.prepare())
    expect(
      await runPromise(core.commit([observation('a')], ['test/a.test.ts'])),
    ).not.toBeNull()
    expect(existsSync(join(root, 'verification'))).toBe(false)
  })
})

describe('beginRun for a partitioned run', () => {
  const live = ManagedRuntime.make(EngineLive)
  afterAll(() => live.dispose())

  test('ignores the stored graph and plans an isolated record', async () => {
    const root = project()
    const recording = new TiaCore({ ...OPTIONS, root })
    await recording.prepare()
    await recording.commit([observation('a')], ['test/a.test.ts'])

    const begun = await live.runPromise(
      beginRun({
        cacheDir: recording.cacheDir,
        ignoredPrefixes: ['.tia'],
        options: recording.options,
        partitioned: true,
        root,
        snapshot: { baseline: null, fingerprint: 'partition' },
      }),
    )
    expect(begun.plan.mode).toBe('record')
    expect(begun.plan.baseline).toEqual({
      origin: 'none',
      reason: 'partitioned run records an isolated graph fragment',
      sha: null,
      source: null,
    })
  })
})
