import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, test } from 'vitest'

import { captureBaseline } from '../../../src/engine/baseline/capture.js'
import { createRunPlan } from '../../../src/engine/planning/runtime.js'
import type {
  NormalizedOptions,
  TiaRuntimeGraph,
} from '../../../src/shared/types.js'

const temporaryDirectories: string[] = []

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-plan-'))
  temporaryDirectories.push(root)

  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src/b.ts'), 'export const b = 2\n')
  writeFileSync(join(root, 'test/a.test.ts'), 'test("a", () => {})\n')
  writeFileSync(join(root, 'test/b.test.ts'), 'test("b", () => {})\n')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')

  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'tia@example.test'])
  git(root, ['config', 'user.name', 'TIA'])
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'baseline'])
  return root
}

const options: NormalizedOptions = {
  cacheDir: '.tia',
  artifactTrust: {},
  coverage: false,
  enabled: true,
  exclude: [],
  fresh: false,
  artifactProviders: [],
  frameworkAdapters: [],
  frameworkFingerprint: '',
  ignoreChanges: [],
  include: ['**/*.ts'],
  log: false,
  onUnknownChange: 'full',
  replayAdapters: [],
  replayReporters: [],
}

function graph(root: string): TiaRuntimeGraph {
  const baseline = captureBaseline(root, '.tia')
  if (baseline === null) {
    throw new Error('expected Git baseline')
  }

  return {
    baseline,
    collectionCoverage: {},
    complete: true,
    coverageComplete: true,
    edges: {
      'test/a.test.ts': ['src/a.ts', 'test/a.test.ts'],
      'test/b.test.ts': ['src/b.ts', 'test/b.test.ts'],
    },
    fingerprint: 'fingerprint',
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
    schema: 3,
    testCoverage: {},
    testEdges: {
      a: {
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
      },
      b: {
        file: 'test/b.test.ts',
        files: ['src/b.ts', 'test/b.test.ts'],
      },
    },
    updatedAt: new Date(0).toISOString(),
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('run planning', () => {
  test('tracks nested source directories that share output directory names', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-filesystem-baseline-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'src/coverage'), { recursive: true })
    mkdirSync(join(root, 'coverage'), { recursive: true })
    writeFileSync(join(root, 'src/coverage/index.ts'), 'export const hit = 1\n')
    writeFileSync(join(root, 'coverage/generated.json'), '{}\n')

    const baseline = captureBaseline(root, '.tia')

    expect(baseline).toMatchObject({ source: 'filesystem' })
    expect(baseline?.workingTree).toHaveProperty('src/coverage/index.ts')
    expect(baseline?.workingTree).not.toHaveProperty('coverage/generated.json')
  })

  test('records a full suite when complete coverage evidence is unavailable', () => {
    const root = fixture()
    const cached = graph(root)
    cached.coverageComplete = false

    const plan = createRunPlan({
      cachePrefix: '.tia',
      coverageRequested: true,
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('record')
    expect(plan.reason).toContain('coverage graph is incomplete')
  })

  test('selects tests linked to changes and always reruns cached failures', () => {
    const root = fixture()
    const cached = graph(root)
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.affectedTests).toEqual(['test/a.test.ts', 'test/b.test.ts'])
    expect(plan.changedFiles).toEqual(['src/a.ts'])
    expect(plan.affectedTestIds).toEqual(['a', 'b'])
    expect(plan.baseline).toMatchObject({
      origin: 'local',
      reason: 'graph supplied directly to the planner',
      source: 'git',
    })
    expect(plan.decisions).toEqual([
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
    expect(plan.wholeTestFiles).toEqual([])
    expect(plan.replayedTests).toBe(0)
  })

  test('normalizes repository changes to a nested project root', () => {
    const repository = mkdtempSync(join(tmpdir(), 'tiacore-monorepo-'))
    temporaryDirectories.push(repository)
    const root = join(repository, 'packages/domain')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'test'))
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'test/a.test.ts'), 'test("a", () => {})\n')
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(repository, 'package.json'), '{"private":true}\n')
    git(repository, ['init', '-q'])
    git(repository, ['config', 'user.email', 'tia@example.test'])
    git(repository, ['config', 'user.name', 'TIA'])
    git(repository, ['add', '.'])
    git(repository, ['commit', '-qm', 'baseline'])

    const baseline = captureBaseline(root, '.tia')
    if (baseline === null) {
      throw new Error('expected nested Git baseline')
    }
    const cached = graph(root)
    cached.baseline = baseline
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.changedFiles).toEqual(['src/a.ts'])
    expect(plan.affectedTests).toEqual(['test/a.test.ts'])
    expect(plan.affectedTestIds).toEqual(['a'])
  })

  test('falls back to the full suite for any unknown file change', () => {
    const root = fixture()
    const cached = graph(root)
    writeFileSync(join(root, 'src/styles.css'), '.button { color: red }\n')

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('record')
    expect(plan.reason).toContain('src/styles.css')
    expect(plan.changedFiles).toEqual(['src/styles.css'])
    expect(plan.decisions).toEqual([
      {
        reasons: ['changed file is unknown to the graph: src/styles.css'],
        target: 'run',
      },
    ])
  })

  test('ignores Vite temporary config bundles created during startup', () => {
    const root = fixture()
    const cached = graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(
      join(root, 'vitest.config.ts.timestamp-1785371646448-fd4ecc6d85bf58.mjs'),
      'export default {}\n',
    )

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.changedFiles).toEqual([])
  })

  test('ignores Bun temporary build files created during a concurrent build', () => {
    const root = fixture()
    const cached = graph(root)
    cached.results.b!.state = 'passed'
    mkdirSync(join(root, 'apps'))
    writeFileSync(
      join(root, 'apps/.18c767bfb8edfdfd-00000000.bun-build'),
      'temporary output\n',
      { flag: 'w' },
    )

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.changedFiles).toEqual([])
  })

  test.skipIf(process.platform === 'win32')(
    'fails closed when a relevant file cannot be read',
    () => {
      const root = fixture()
      const cached = graph(root)
      cached.results.b!.state = 'passed'
      const unreadable = join(root, 'src/unreadable.ts')
      writeFileSync(unreadable, 'export const unreadable = true\n')
      chmodSync(unreadable, 0o000)

      expect(captureBaseline(root, '.tia')).toBeNull()
      const plan = createRunPlan({
        cachePrefix: '.tia',
        fingerprint: 'fingerprint',
        graph: cached,
        options,
        root,
      })
      expect(plan.mode).toBe('record')
      expect(plan.reason).toContain('recorded commit is unavailable')
    },
  )

  test('can explicitly ignore all unknown changes', () => {
    const root = fixture()
    const cached = graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'src/new.ts'), 'export const value = 1\n')

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options: { ...options, onUnknownChange: 'ignore' },
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.affectedTests).toEqual([])
    expect(plan.affectedTestIds).toEqual([])
    expect(plan.replayedTests).toBe(2)
  })

  test('can ignore matching unknown changes without hiding other files', () => {
    const root = fixture()
    const cached = graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'notes.md'), '# Notes\n')

    const ignored = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options: { ...options, ignoreChanges: ['**/*.md'] },
      root,
    })

    expect(ignored.mode).toBe('replay')
    expect(ignored.affectedTests).toEqual([])

    writeFileSync(join(root, 'src/styles.css'), '.button { color: red }\n')
    const unsafe = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options: { ...options, ignoreChanges: ['**/*.md'] },
      root,
    })

    expect(unsafe.mode).toBe('record')
    expect(unsafe.reason).toContain('src/styles.css')
  })

  test('never ignores changed structural files', () => {
    const root = fixture()
    const cached = graph(root)
    writeFileSync(
      join(root, 'package.json'),
      '{"type":"module","private":true}\n',
    )

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options: { ...options, ignoreChanges: ['**/*'] },
      root,
    })

    expect(plan.mode).toBe('record')
    expect(plan.reason).toContain('structural file changed')
  })

  test('does not repeatedly select a stable dirty file', () => {
    const root = fixture()
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')
    const cached = graph(root)

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.changedFiles).toEqual([])
    expect(plan.affectedTests).toEqual(['test/b.test.ts'])
    expect(plan.affectedTestIds).toEqual(['b'])
  })

  test('selects a file restored after a dirty baseline', () => {
    const root = fixture()
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')
    const cached = graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.changedFiles).toEqual(['src/a.ts'])
    expect(plan.affectedTests).toEqual(['test/a.test.ts'])
    expect(plan.affectedTestIds).toEqual(['a'])
  })

  test('falls back to the whole linked file when per-case edges are incomplete', () => {
    const root = fixture()
    const cached = graph(root)
    cached.results.b!.state = 'passed'
    cached.testEdges = {}
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 3\n')

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.affectedTests).toEqual(['test/a.test.ts'])
    expect(plan.affectedTestIds).toEqual([])
    expect(plan.wholeTestFiles).toEqual(['test/a.test.ts'])
    expect(plan.replayedTests).toBe(1)
    expect(plan.decisions).toEqual([
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

  test('reruns an imprecise failed test as a whole file', () => {
    const root = fixture()
    const cached = graph(root)
    delete cached.testEdges.b

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.affectedTests).toEqual(['test/b.test.ts'])
    expect(plan.affectedTestIds).toEqual([])
    expect(plan.wholeTestFiles).toEqual(['test/b.test.ts'])
  })

  test('runs every case when the test file itself changed', () => {
    const root = fixture()
    const cached = graph(root)
    cached.results.b!.state = 'passed'
    writeFileSync(join(root, 'test/a.test.ts'), 'test("a changed", () => {})\n')

    const plan = createRunPlan({
      cachePrefix: '.tia',
      fingerprint: 'fingerprint',
      graph: cached,
      options,
      root,
    })

    expect(plan.mode).toBe('replay')
    expect(plan.affectedTests).toEqual(['test/a.test.ts'])
    expect(plan.affectedTestIds).toEqual([])
    expect(plan.wholeTestFiles).toEqual(['test/a.test.ts'])
    expect(plan.decisions).toEqual([
      {
        file: 'test/a.test.ts',
        reasons: ['test file changed: test/a.test.ts'],
        target: 'test-file',
      },
    ])
  })
})
