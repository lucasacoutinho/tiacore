import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

import type {
  Baseline,
  RunPlan,
  RuntimePlanOptions,
  TiaRuntimeGraph,
} from '../../src/core/runtime.ts'
import { beginRun } from '../../src/engine/lifecycle.ts'
import {
  baselinesMemory,
  type MemoryProject,
} from '../../src/engine/baseline/memory.ts'
import { Baselines, GraphStore } from '../../src/engine/ports.ts'
import { GraphStoreMemory } from '../../src/engine/state/memory-store.ts'
import { commit, init, put, scratch, cleanupScratch } from './support/repos.ts'
import { baseGraph } from './support/graphs.ts'
import { EngineLive } from './support/layers.ts'

// Planning goes through `beginRun`, which reads the stored graph and asks
// `Baselines` what changed, so each scenario stores its graph first. The plan's
// baseline reason names the local store as the source of the graph.

const live = ManagedRuntime.make(EngineLive)
afterAll(() => live.dispose())

const temporaryDirectories: string[] = []

afterEach(() => {
  cleanupScratch()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function fixture(): string {
  const root = scratch('tiacore-plan-')
  put(root, 'src/a.ts', 'export const a = 1\n')
  put(root, 'src/b.ts', 'export const b = 2\n')
  put(root, 'test/a.test.ts', 'test("a", () => {})\n')
  put(root, 'test/b.test.ts', 'test("b", () => {})\n')
  put(root, 'package.json', '{"type":"module"}\n')
  init(root)
  commit(root, 'baseline')
  return root
}

const options: RuntimePlanOptions = {
  fresh: false,
  ignoreChanges: [],
  onUnknownChange: 'full',
}

const CACHE_PREFIX = '.tia'

function capture(root: string): Promise<Baseline | null> {
  return live.runPromise(
    Effect.flatMap(Baselines, (baselines) =>
      baselines.capture(root, [CACHE_PREFIX]),
    ),
  )
}

async function graph(root: string): Promise<TiaRuntimeGraph> {
  const baseline = await capture(root)
  if (baseline === null) {
    throw new Error('expected Git baseline')
  }

  return baseGraph({
    baseline,
    coverageComplete: true,
    results: {
      a: {
        file: 'test/a.test.ts',
        fullName: 'a',
        id: 'a',
        state: 'passed',
      },
      b: {
        file: 'test/b.test.ts',
        fullName: 'b',
        id: 'b',
        state: 'failed',
      },
    },
  })
}

interface PlanRequest {
  coverageRequested?: boolean
  options?: RuntimePlanOptions
}

/** Stores `cached` as the project's graph, then plans a run against it. */
function plan(
  root: string,
  cached: TiaRuntimeGraph,
  request: PlanRequest = {},
): Promise<RunPlan> {
  const cacheDir = join(root, CACHE_PREFIX, 'plan')
  return live.runPromise(
    Effect.gen(function* () {
      const store = yield* GraphStore
      yield* store.purge(cacheDir)
      yield* store.commit(cacheDir, {
        expected: null,
        expectedDigest: null,
        graph: cached,
      })
      const begun = yield* beginRun<never>({
        cacheDir,
        ...(request.coverageRequested === undefined
          ? {}
          : { coverageRequested: request.coverageRequested }),
        ignoredPrefixes: [CACHE_PREFIX],
        options: request.options ?? options,
        root,
        snapshot: { baseline: null, fingerprint: cached.fingerprint },
      })
      return begun.plan
    }),
  )
}

describe('run planning', () => {
  test('tracks nested source directories that share output directory names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-filesystem-baseline-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'src/coverage'), { recursive: true })
    mkdirSync(join(root, 'coverage'), { recursive: true })
    writeFileSync(join(root, 'src/coverage/index.ts'), 'export const hit = 1\n')
    writeFileSync(join(root, 'coverage/generated.json'), '{}\n')

    const baseline = await capture(root)

    expect(baseline).toMatchObject({ source: 'filesystem' })
    expect(baseline?.workingTree).toHaveProperty('src/coverage/index.ts')
    expect(baseline?.workingTree).not.toHaveProperty('coverage/generated.json')
  })

  test('records a full suite when complete coverage evidence is unavailable', async () => {
    const root = fixture()
    const cached = await graph(root)
    cached.coverageComplete = false

    const result = await plan(root, cached, { coverageRequested: true })

    expect(result.mode).toBe('record')
    expect(result.reason).toContain('coverage graph is incomplete')
  })

  test('selects tests linked to changes and always reruns cached failures', async () => {
    const root = fixture()
    const cached = await graph(root)
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.affectedTests).toEqual(['test/a.test.ts', 'test/b.test.ts'])
    expect(result.changedFiles).toEqual(['src/a.ts'])
    expect(result.affectedTestIds).toEqual(['a', 'b'])
    expect(result.baseline).toMatchObject({
      origin: 'local',
      reason: 'local graph loaded',
      source: 'git',
    })
    expect(result.decisions).toEqual([
      {
        file: 'test/a.test.ts',
        id: 'a',
        reasons: ['observed dependency changed: src/a.ts'],
        target: 'test-case',
      },
      {
        file: 'test/b.test.ts',
        id: 'b',
        reasons: ['previous test failed: b'],
        target: 'test-case',
      },
    ])
    expect(result.wholeTestFiles).toEqual([])
    expect(result.replayedTests).toBe(0)
  })

  test('normalizes repository changes to a nested project root', async () => {
    const repository = scratch('tiacore-monorepo-')
    const root = join(repository, 'packages/domain')
    put(root, 'src/a.ts', 'export const a = 1\n')
    put(root, 'test/a.test.ts', 'test("a", () => {})\n')
    put(root, 'package.json', '{"type":"module"}\n')
    put(repository, 'package.json', '{"private":true}\n')
    init(repository)
    commit(repository, 'baseline')

    const baseline = await capture(root)
    if (baseline === null) {
      throw new Error('expected nested Git baseline')
    }
    const cached = await graph(root)
    cached.baseline = baseline
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.changedFiles).toEqual(['src/a.ts'])
    expect(result.affectedTests).toEqual(['test/a.test.ts'])
    expect(result.affectedTestIds).toEqual(['a'])
  })

  test('treats a repository-root lockfile as structural from a nested project', async () => {
    const repository = scratch('tiacore-monorepo-')
    const root = join(repository, 'packages/a')
    put(root, 'src/a.ts', 'export const a = 1\n')
    put(root, 'test/a.test.ts', 'test("a", () => {})\n')
    put(root, 'package.json', '{"type":"module"}\n')
    put(repository, 'package.json', '{"private":true}\n')
    put(repository, 'bun.lock', '{"lockfileVersion":1}\n')
    init(repository)
    commit(repository, 'baseline')

    const baseline = await capture(root)
    if (baseline === null) throw new Error('expected nested Git baseline')
    const cached = await graph(root)
    cached.baseline = baseline
    cached.results.b!.state = 'passed'
    writeFileSync(
      join(repository, 'bun.lock'),
      '{"lockfileVersion":1,"changed":true}\n',
    )

    const result = await plan(root, cached, {
      options: { ...options, onUnknownChange: 'ignore' },
    })

    expect({
      changedFiles: result.changedFiles,
      mode: result.mode,
      reason: result.reason,
    }).toEqual({
      changedFiles: ['../../bun.lock'],
      mode: 'record',
      reason: 'structural file changed: ../../bun.lock',
    })
  })

  test('does not treat a nested manifest or an ancestor note as structural', async () => {
    const repository = scratch('tiacore-monorepo-')
    const root = join(repository, 'packages/a')
    put(root, 'src/a.ts', 'export const a = 1\n')
    put(root, 'test/a.test.ts', 'test("a", () => {})\n')
    put(root, 'package.json', '{"type":"module"}\n')
    put(repository, 'package.json', '{"private":true}\n')
    put(repository, 'notes.md', '# Notes\n')
    init(repository)
    commit(repository, 'baseline')

    const baseline = await capture(root)
    if (baseline === null) throw new Error('expected nested Git baseline')
    const cached = await graph(root)
    cached.baseline = baseline
    cached.results.b!.state = 'passed'
    const ignoreUnknown = { ...options, onUnknownChange: 'ignore' as const }

    put(root, 'nested/package.json', '{"name":"nested"}\n')
    const nested = await plan(root, cached, { options: ignoreUnknown })
    expect(nested.mode).toBe('replay')
    expect(nested.reason).toBe('no affected test files')

    writeFileSync(join(repository, 'notes.md'), '# Edited\n')
    const note = await plan(root, cached, { options: ignoreUnknown })
    expect(note.mode).toBe('replay')
    expect(note.reason).toBe('no affected test files')
  })

  test('falls back to the full suite for any unknown file change', async () => {
    const root = fixture()
    const cached = await graph(root)
    writeFileSync(join(root, 'src/styles.css'), '.button { color: red }\n')

    const result = await plan(root, cached)

    expect(result.mode).toBe('record')
    expect(result.reason).toContain('src/styles.css')
    expect(result.changedFiles).toEqual(['src/styles.css'])
    expect(result.decisions).toEqual([
      {
        reasons: ['changed file is unknown to the graph: src/styles.css'],
        target: 'run',
      },
    ])
  })

  test('ignores Vite temporary config bundles created during startup', async () => {
    const root = fixture()
    const cached = await graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(
      join(root, 'vitest.config.ts.timestamp-1785371646448-fd4ecc6d85bf58.mjs'),
      'export default {}\n',
    )

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.changedFiles).toEqual([])
  })

  test('ignores Bun temporary build files created during a concurrent build', async () => {
    const root = fixture()
    const cached = await graph(root)
    cached.results.b!.state = 'passed'
    mkdirSync(join(root, 'apps'))
    writeFileSync(
      join(root, 'apps/.18c767bfb8edfdfd-00000000.bun-build'),
      'temporary output\n',
      { flag: 'w' },
    )

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.changedFiles).toEqual([])
  })

  // A process running as root reads every file, so the premise (an unreadable
  // file) cannot be set up there.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed when a relevant file cannot be read',
    async () => {
      const root = fixture()
      const cached = await graph(root)
      cached.results.b!.state = 'passed'
      const unreadable = join(root, 'src/unreadable.ts')
      writeFileSync(unreadable, 'export const unreadable = true\n')
      chmodSync(unreadable, 0o000)

      expect(await capture(root)).toBeNull()
      const result = await plan(root, cached)
      expect(result.mode).toBe('record')
      expect(result.reason).toContain('recorded commit is unavailable')
    },
  )

  test('can explicitly ignore all unknown changes', async () => {
    const root = fixture()
    const cached = await graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'src/new.ts'), 'export const value = 1\n')

    const result = await plan(root, cached, {
      options: { ...options, onUnknownChange: 'ignore' },
    })

    expect(result.mode).toBe('replay')
    expect(result.affectedTests).toEqual([])
    expect(result.affectedTestIds).toEqual([])
    expect(result.replayedTests).toBe(2)
  })

  test('can ignore matching unknown changes without hiding other files', async () => {
    const root = fixture()
    const cached = await graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'notes.md'), '# Notes\n')

    const ignored = await plan(root, cached, {
      options: { ...options, ignoreChanges: ['**/*.md'] },
    })

    expect(ignored.mode).toBe('replay')
    expect(ignored.affectedTests).toEqual([])

    writeFileSync(join(root, 'src/styles.css'), '.button { color: red }\n')
    const unsafe = await plan(root, cached, {
      options: { ...options, ignoreChanges: ['**/*.md'] },
    })

    expect(unsafe.mode).toBe('record')
    expect(unsafe.reason).toContain('src/styles.css')
  })

  test('never ignores changed structural files', async () => {
    const root = fixture()
    const cached = await graph(root)
    writeFileSync(
      join(root, 'package.json'),
      '{"type":"module","private":true}\n',
    )

    const result = await plan(root, cached, {
      options: { ...options, ignoreChanges: ['**/*'] },
    })

    expect(result.mode).toBe('record')
    expect(result.reason).toContain('structural file changed')
  })

  test('does not repeatedly select a stable dirty file', async () => {
    const root = fixture()
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')
    const cached = await graph(root)

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.changedFiles).toEqual([])
    expect(result.affectedTests).toEqual(['test/b.test.ts'])
    expect(result.affectedTestIds).toEqual(['b'])
  })

  test('selects a file restored after a dirty baseline', async () => {
    const root = fixture()
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')
    const cached = await graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.changedFiles).toEqual(['src/a.ts'])
    expect(result.affectedTests).toEqual(['test/a.test.ts'])
    expect(result.affectedTestIds).toEqual(['a'])
  })

  test('falls back to the whole linked file when per-case edges are incomplete', async () => {
    const root = fixture()
    const cached = await graph(root)
    cached.results.b!.state = 'passed'
    cached.testEdges = {}
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.affectedTests).toEqual(['test/a.test.ts'])
    expect(result.affectedTestIds).toEqual([])
    expect(result.wholeTestFiles).toEqual(['test/a.test.ts'])
    expect(result.replayedTests).toBe(1)
    expect(result.decisions).toEqual([
      {
        file: 'test/a.test.ts',
        reasons: [
          'observed dependency changed: src/a.ts',
          'test-level dependency metadata is incomplete for change: src/a.ts',
        ],
        target: 'test-file',
      },
    ])
  })

  test('reruns an imprecise failed test as a whole file', async () => {
    const root = fixture()
    const cached = await graph(root)
    delete cached.testEdges.b

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.affectedTests).toEqual(['test/b.test.ts'])
    expect(result.affectedTestIds).toEqual([])
    expect(result.wholeTestFiles).toEqual(['test/b.test.ts'])
  })

  test('runs every case when the test file itself changed', async () => {
    const root = fixture()
    const cached = await graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'test/a.test.ts'), 'test("a changed", () => {})\n')

    const result = await plan(root, cached)

    expect(result.mode).toBe('replay')
    expect(result.affectedTests).toEqual(['test/a.test.ts'])
    expect(result.affectedTestIds).toEqual([])
    expect(result.wholeTestFiles).toEqual(['test/a.test.ts'])
    expect(result.decisions).toEqual([
      {
        file: 'test/a.test.ts',
        reasons: ['test file changed: test/a.test.ts'],
        target: 'test-file',
      },
    ])
  })
})

// The same planner over the in-memory adapters. Test files still have to exist
// on disk, because the lifecycle checks them there; their content is irrelevant.

describe('run planning over in-memory adapters', () => {
  const FILES = {
    'package.json': 'h-package',
    'src/a.ts': 'h-a',
    'src/b.ts': 'h-b',
    'test/a.test.ts': 'h-ta',
    'test/b.test.ts': 'h-tb',
  }

  async function memoryPlan(
    prepare: (project: MemoryProject, cached: TiaRuntimeGraph) => void,
    request: PlanRequest = {},
  ): Promise<RunPlan> {
    const root = scratch('tiacore-plan-memory-')
    for (const file of Object.keys(FILES)) put(root, file)
    const project: MemoryProject = {
      commits: [{ files: { ...FILES }, sha: 'c1' }],
      files: { ...FILES },
    }
    const projects = new Map([[root, project]])
    const cacheDir = join(root, CACHE_PREFIX, 'plan')
    const layer = Layer.mergeAll(GraphStoreMemory, baselinesMemory(projects))
    return Effect.runPromise(
      Effect.gen(function* () {
        const baseline = yield* Effect.flatMap(Baselines, (baselines) =>
          baselines.capture(root, [CACHE_PREFIX]),
        )
        if (baseline === null) throw new Error('expected a memory baseline')
        const cached = baseGraph({
          baseline,
          coverageComplete: true,
          results: {
            a: {
              file: 'test/a.test.ts',
              fullName: 'a',
              id: 'a',
              state: 'passed',
            },
            b: {
              file: 'test/b.test.ts',
              fullName: 'b',
              id: 'b',
              state: 'failed',
            },
          },
        })
        prepare(project, cached)
        const store = yield* GraphStore
        yield* store.commit(cacheDir, {
          expected: null,
          expectedDigest: null,
          graph: cached,
        })
        const begun = yield* beginRun<never>({
          cacheDir,
          ignoredPrefixes: [CACHE_PREFIX],
          options: request.options ?? options,
          root,
          snapshot: { baseline: null, fingerprint: cached.fingerprint },
        })
        return begun.plan
      }).pipe(Effect.provide(layer)),
    )
  }

  test('selects the dependents of a changed file and reruns cached failures', async () => {
    const result = await memoryPlan((project) => {
      project.files['src/a.ts'] = 'h-a-edited'
    })
    expect(result).toMatchObject({
      affectedTestIds: ['a', 'b'],
      affectedTests: ['test/a.test.ts', 'test/b.test.ts'],
      baseline: { origin: 'local', source: 'git' },
      changedFiles: ['src/a.ts'],
      mode: 'replay',
    })
  })

  test('replays everything when only a passing result is cached', async () => {
    const result = await memoryPlan((_, cached) => {
      cached.results.b!.state = 'passed'
    })
    expect(result).toMatchObject({
      affectedTests: [],
      changedFiles: [],
      mode: 'replay',
      reason: 'no affected test files',
      replayedTests: 2,
    })
  })

  test('falls back to the full suite for an unknown untracked file', async () => {
    const result = await memoryPlan((project) => {
      project.files['src/styles.css'] = 'h-css'
      project.untracked = ['src/styles.css']
    })
    expect(result.mode).toBe('record')
    expect(result.decisions).toEqual([
      {
        reasons: ['changed file is unknown to the graph: src/styles.css'],
        target: 'run',
      },
    ])
  })

  test('fails closed when a changed file cannot be read', async () => {
    const result = await memoryPlan((project) => {
      project.files['src/a.ts'] = '<unavailable>'
    })
    expect(result.mode).toBe('record')
    expect(result.reason).toContain('recorded commit is unavailable')
  })

  test('ignores temporary tool files and never ignores a structural file', async () => {
    const temporary =
      'vitest.config.ts.timestamp-1785371646448-fd4ecc6d85bf58.mjs'
    const ignored = await memoryPlan((project, cached) => {
      cached.results.b!.state = 'passed'
      project.files[temporary] = 'h-temp'
      project.untracked = [temporary]
    })
    expect(ignored).toMatchObject({ changedFiles: [], mode: 'replay' })

    const structural = await memoryPlan(
      (project) => {
        project.files['package.json'] = 'h-package-edited'
      },
      { options: { ...options, ignoreChanges: ['**/*'] } },
    )
    expect(structural.mode).toBe('record')
    expect(structural.reason).toContain('structural file changed')
  })
})
