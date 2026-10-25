import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { nodeDiscoveryHooksSupported } from '../../../src/runners/node/discovery.ts'
import {
  cleanupProjects,
  createFixtureProject,
  executions,
  readGraph,
  resetExecutions,
  runCommand,
} from '../../support/runner-project.ts'

// Ports of the node:test, bun:test and custom adapter cases of 1.x
// test/integration/vitest/fixture.integration.test.ts, run against the built
// package through real fixture projects.

afterEach(cleanupProjects)

const hasBun = runCommand(process.cwd(), 'bun', ['--version']).status === 0
const hooks = nodeDiscoveryHooksSupported()

describe.skipIf(!hasBun)('bun:test fixture project', () => {
  test('selects exact bun:test cases and falls back for unknown changes', async () => {
    const root = createFixtureProject('bun-runner')

    const initial = runCommand(root, 'bun', ['run-tia.ts'])
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['bun-a', 'bun-b'])
    expect(initial.output).toContain('TIA bun recording full-suite baseline')
    const graph = await readGraph(root, 'bun')
    const aResult = Object.values(graph.results).find(
      (result) => result.fullName === 'bun case a',
    )
    const bResult = Object.values(graph.results).find(
      (result) => result.fullName === 'bun case b',
    )
    expect(graph.testEdges[aResult!.id]?.files).toContain('src/a.ts')
    expect(graph.testEdges[aResult!.id]?.files).not.toContain('src/b.ts')
    expect(graph.testEdges[bResult!.id]?.files).toContain('src/b.ts')

    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    const replay = runCommand(root, 'bun', ['run-tia.ts'])
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual(['bun-a'])
    expect(replay.output).toContain('1 affected test case')
    expect(replay.output).toContain('1 cached test result')

    resetExecutions(root)
    writeFileSync(join(root, 'notes.txt'), 'untracked behavior note\n')
    const fallback = runCommand(root, 'bun', ['run-tia.ts'])
    expect(fallback.status, fallback.output).toBe(0)
    expect(executions(root).sort()).toEqual(['bun-a', 'bun-b'])
    expect(fallback.output).toContain(
      'changed file is unknown to the graph: notes.txt',
    )

    resetExecutions(root)
    appendFileSync(join(root, 'test/example.test.ts'), '\n')
    const changedTest = runCommand(root, 'bun', ['run-tia.ts'])
    expect(changedTest.status, changedTest.output).toBe(0)
    expect(executions(root).sort()).toEqual(['bun-a', 'bun-b'])
    expect(changedTest.output).toContain('1 whole-file fallback')
  })
})

describe('node:test fixture project', () => {
  test('selects exact node:test cases and reruns cached failures', async () => {
    const root = createFixtureProject('node-runner')

    const initial = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['node-a', 'node-b'])
    expect(initial.output).toContain('TIA node recording full-suite baseline')
    const initialGraph = await readGraph(root, 'node')
    const find = (name: string) =>
      Object.values(initialGraph.results).find(
        (result) => result.fullName === name,
      )
    const aResult = find('node case a')
    const bResult = find('node case b')
    expect(initialGraph.testEdges[aResult!.id]?.files).toContain('src/a.mjs')
    expect(initialGraph.testEdges[aResult!.id]?.files).not.toContain(
      'src/b.mjs',
    )
    expect(initialGraph.testEdges[bResult!.id]?.files).toContain('src/b.mjs')
    if (hooks) {
      // The skipped case is only visible to precise discovery.
      expect(find('node skipped case')?.state).toBe('skipped')
    }

    resetExecutions(root)
    writeFileSync(join(root, 'src/a.mjs'), "export const a = () => 'broken'\n")
    const failed = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(failed.status, failed.output).toBe(1)
    expect(executions(root)).toEqual(['node-a'])
    expect(failed.output).toContain('1 affected test case')

    resetExecutions(root)
    const retried = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(retried.status, retried.output).toBe(1)
    expect(executions(root)).toEqual(['node-a'])

    resetExecutions(root)
    writeFileSync(join(root, 'src/a.mjs'), "export const a = () => 'a'\n")
    const repaired = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(repaired.status, repaired.output).toBe(0)
    expect(executions(root)).toEqual(['node-a'])
  })

  test('records and recovers a node:test module-load failure', async () => {
    const root = createFixtureProject('node-module-failure')
    const failed = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(failed.status, failed.output).toBe(1)
    expect(Object.values((await readGraph(root, 'node')).results)).toEqual([
      expect.objectContaining({
        fullName: 'test/broken.test.mjs (module failure)',
        state: 'failed',
      }),
    ])

    writeFileSync(
      join(root, 'src/missing.mjs'),
      "export const value = 'recovered'\n",
    )
    const recovered = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(recovered.status, recovered.output).toBe(0)
    expect(executions(root)).toEqual(['module-recovered'])
  })

  test('uses one aggregate Node coverage pass when hooks are unavailable', async () => {
    const root = createFixtureProject('node-runner')
    const result = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000, {
      TIACORE_NODE_DISCOVERY_HOOKS: '0',
    })
    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['node-a', 'node-b'])

    const graph = await readGraph(root, 'node')
    const caseA = Object.values(graph.results).find(
      (cached) => cached.fullName === 'node case a',
    )!
    expect(graph.testEdges[caseA.id]?.files).toEqual(
      expect.arrayContaining(['src/a.mjs', 'src/b.mjs']),
    )
  })

  // NODE-AGG-02, end to end: the aggregate pass cannot vouch for a project
  // whose module failed to load, so the run fails and nothing is saved.
  test('the aggregate path fails closed on a module-load failure', async () => {
    const root = createFixtureProject('node-module-failure')
    const result = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000, {
      TIACORE_NODE_DISCOVERY_HOOKS: '0',
    })
    expect(result.status, result.output).toBe(1)
    expect(result.output).toContain('the graph was not saved')
    await expect(readGraph(root, 'node')).rejects.toThrow(
      'expected a valid TIA runtime state',
    )
  })

  test.skipIf(!hooks)(
    'discovers and replays a nested node:test name without running it twice',
    async () => {
      const root = createFixtureProject('node-nested')
      const initial = runCommand(root, process.execPath, ['run-tia.mjs'])
      expect(executions(root).sort()).toEqual(['node-commonjs', 'node-nested'])
      expect(initial.status, initial.output).toBe(0)
      expect(
        Object.values((await readGraph(root, 'node')).results).map(
          (result) => result.fullName,
        ),
      ).toEqual(
        expect.arrayContaining(['CommonJS case', 'account suite nested case']),
      )

      resetExecutions(root)
      writeFileSync(join(root, 'src/a.mjs'), "export const a = () => 'a'\n\n")
      const replay = runCommand(root, process.execPath, ['run-tia.mjs'])
      expect(replay.status, replay.output).toBe(0)
      expect(executions(root)).toEqual(['node-nested'])
    },
  )
})

describe('custom adapter fixture project', () => {
  test('uses the public adapter entry point for full, replay, and changed runs', () => {
    const root = createFixtureProject('custom-adapter')

    const first = runCommand(root, process.execPath, ['run.mjs'])
    expect(first.status, first.output).toBe(0)
    expect(first.output).toContain('"mode":"record"')

    const replay = runCommand(root, process.execPath, ['run.mjs'])
    expect(replay.status, replay.output).toBe(0)
    expect(replay.output).toContain('"selectedTests":0')

    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2\n')
    const changed = runCommand(root, process.execPath, ['run.mjs'])
    expect(changed.status, changed.output).toBe(0)
    expect(changed.output).toContain('"selectedTests":1')
    expect(executions(root)).toEqual(['external:value:1', 'external:value:2'])
  })
})
