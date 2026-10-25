import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createLinkedWorktree,
  createProject,
  executions,
  git,
  readGraph,
  readGraphAt,
  resetExecutions,
  runVitest,
  runVitestAsync,
} from '../../support/integration-project.ts'

afterEach(cleanupProjects)

// The divergence test needs both Vitest processes to have read the shared
// graph before either commits. Without a barrier that overlap is a race on
// process start-up (1.x lost it in 1 of 35 runs, 2.0 in 2 of 11), so each
// test body announces itself in TIA_BARRIER_DIR and waits, for at most four
// seconds, until the other process has done the same. Without the variable
// the tests run unchanged.
const barrierTest = (name: string, source: string): string => `
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from 'vitest'

function meet() {
  const directory = process.env.TIA_BARRIER_DIR
  if (directory === undefined) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, Buffer.from(process.cwd()).toString('hex')), '')
  const deadline = Date.now() + 4_000
  while (readdirSync(directory).length < 2 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
}

test('${name}', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), '${name}\\n')
  meet()
  const { ${name} } = await import('../src/${source}')
  expect(${name}()).toBe('${name}')
})
`

describe('Git worktrees', () => {
  test('runs linked worktrees in parallel with independent default caches', async () => {
    const root = createProject()
    const worktree = createLinkedWorktree(root, 'independent')

    const initial = await Promise.all([
      runVitestAsync(root),
      runVitestAsync(worktree),
    ])
    expect(
      initial.map((result) => result.status),
      initial.map((result) => result.output).join('\n'),
    ).toEqual([0, 0])
    expect((await readGraph(root)).complete).toBe(true)
    expect((await readGraph(worktree)).complete).toBe(true)

    resetExecutions(root)
    resetExecutions(worktree)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    writeFileSync(join(worktree, 'src/b.ts'), "export const b = () => 'b'\n\n")
    const affected = await Promise.all([
      runVitestAsync(root),
      runVitestAsync(worktree),
    ])

    expect(
      affected.map((result) => result.status),
      affected.map((result) => result.output).join('\n'),
    ).toEqual([0, 0])
    expect(executions(root)).toEqual(['a'])
    expect(executions(worktree)).toEqual(['b'])
  })

  test('reuses an ancestor graph and rejects a non-ancestor baseline', () => {
    const root = createProject()
    const worktree = createLinkedWorktree(root, 'ancestry')
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)

    cpSync(join(root, '.tia'), join(worktree, '.tia'), {
      recursive: true,
    })
    resetExecutions(worktree)
    const reused = runVitest(worktree)
    expect(reused.status, reused.output).toBe(0)
    expect(executions(worktree)).toEqual([])

    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a2'\n")
    git(root, ['add', 'src/a.ts'])
    git(root, ['commit', '-qm', 'advance primary worktree'])
    const advanced = runVitest(root)
    expect(advanced.status, advanced.output).toBe(1)
    rmSync(join(worktree, '.tia'), { force: true, recursive: true })
    cpSync(join(root, '.tia'), join(worktree, '.tia'), {
      recursive: true,
    })
    resetExecutions(worktree)

    const rejected = runVitest(worktree)
    expect(rejected.status, rejected.output).toBe(0)
    expect(rejected.output).toContain('recorded commit is unavailable')
    expect(executions(worktree).sort()).toEqual(['a', 'b'])
  })

  test('serializes a deliberately shared external cache and fails closed after divergence', async () => {
    const root = createProject({
      pluginOptions:
        "{ cacheDir: process.env.TIA_CACHE_DIR ?? '.tia', log: true }",
      testA: barrierTest('a', 'a'),
      testB: barrierTest('b', 'b'),
    })
    const worktree = createLinkedWorktree(root, 'shared-cache')
    const shared = join(root, 'shared-cache')
    const environment = { TIA_CACHE_DIR: shared }

    const initial = await Promise.all([
      runVitestAsync(root, ['run'], 20_000, environment),
      runVitestAsync(worktree, ['run'], 20_000, environment),
    ])
    expect(
      initial.map((result) => result.status),
      initial.map((result) => result.output).join('\n'),
    ).toEqual([0, 0])
    expect(await readGraphAt(shared)).toMatchObject({ complete: true })
    expect(existsSync(join(shared, 'state.lock'))).toBe(false)

    resetExecutions(root)
    resetExecutions(worktree)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    writeFileSync(join(worktree, 'src/b.ts'), "export const b = () => 'b'\n\n")
    const barrierDirectory = mkdtempSync(join(tmpdir(), 'tiacore-barrier-'))
    const barrier = { ...environment, TIA_BARRIER_DIR: barrierDirectory }
    const diverged = await Promise.all([
      runVitestAsync(root, ['run'], 20_000, barrier),
      runVitestAsync(worktree, ['run'], 20_000, barrier),
    ]).finally(() => {
      rmSync(barrierDirectory, { force: true, recursive: true })
    })

    expect(diverged.map((result) => result.status)).toEqual([0, 0])
    expect(
      diverged.filter((result) =>
        result.output.includes('another process committed a conflicting graph'),
      ),
      diverged.map((result) => result.output).join('\n--- other process ---\n'),
    ).toHaveLength(1)
    expect(await readGraphAt(shared)).toMatchObject({ complete: true })
    expect(existsSync(join(shared, 'state.lock'))).toBe(false)
  })
})
