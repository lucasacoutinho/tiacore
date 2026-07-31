import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createLinkedWorktree,
  createProject,
  executions,
  git,
  readGraph,
  resetExecutions,
  runVitest,
  runVitestAsync,
} from '../../helpers/integration-project.js'

afterEach(cleanupProjects)

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
    expect(readGraph(root).complete).toBe(true)
    expect(readGraph(worktree).complete).toBe(true)

    resetExecutions(root)
    resetExecutions(worktree)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    writeFileSync(
      join(worktree, 'src/b.ts'),
      "export const b = () => 'b'\n\n",
    )
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
    expect(
      JSON.parse(
        readFileSync(join(shared, 'graph.json'), 'utf8'),
      ),
    ).toMatchObject({ complete: true })
    expect(existsSync(join(shared, 'graph.lock'))).toBe(false)

    resetExecutions(root)
    resetExecutions(worktree)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    writeFileSync(
      join(worktree, 'src/b.ts'),
      "export const b = () => 'b'\n\n",
    )
    const diverged = await Promise.all([
      runVitestAsync(root, ['run'], 20_000, environment),
      runVitestAsync(worktree, ['run'], 20_000, environment),
    ])

    expect(diverged.map((result) => result.status)).toEqual([0, 0])
    expect(
      diverged.filter((result) =>
        result.output.includes('another process committed a conflicting graph'),
      ),
    ).toHaveLength(1)
    expect(
      JSON.parse(
        readFileSync(join(shared, 'graph.json'), 'utf8'),
      ),
    ).toMatchObject({ complete: true })
    expect(existsSync(join(shared, 'graph.lock'))).toBe(false)
  })
})
