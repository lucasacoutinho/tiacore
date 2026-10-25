import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  cloneProjectWithGraph,
  createProject,
  executions,
  git,
  readGraph,
  resetExecutions,
  runVitest,
  runVitestUntil,
  writeGraphAt,
} from '../../support/integration-project.ts'
import { nodeAtLeast } from '../../support/node-version.ts'

afterEach(() => {
  cleanupProjects()
})

describe('bespoke integration paths', async () => {
  test('rebuilds corrupt caches and baselines whose commit is unavailable', async () => {
    const root = createProject()
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)

    writeFileSync(join(root, '.tia/state.json'), '{"schema":1}\n')
    resetExecutions(root)

    const corrupt = runVitest(root)
    expect(corrupt.status, corrupt.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect(corrupt.output).toContain('no compatible graph found')

    const graph = await readGraph(root)
    graph.baseline.sha = '0000000000000000000000000000000000000000'
    await writeGraphAt(join(root, '.tia'), graph)
    resetExecutions(root)

    const unreachable = runVitest(root)
    expect(unreachable.status, unreachable.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect(unreachable.output).toContain('recorded commit is unavailable')
  })

  test('selects a renamed test and prunes its old graph entry', async () => {
    const root = createProject()
    expect(runVitest(root).status).toBe(0)
    resetExecutions(root)
    renameSync(join(root, 'test/a.test.ts'), join(root, 'test/renamed.test.ts'))

    const renamed = runVitest(root)
    expect(renamed.status, renamed.output).toBe(0)
    expect(executions(root)).toEqual(['a'])

    const graph = await readGraph(root)
    expect(graph.edges['test/a.test.ts']).toBeUndefined()
    expect(graph.edges['test/renamed.test.ts']).toContain('src/a.ts')
  })

  test('records and reruns a runtime failure after a dynamic dependency is deleted', async () => {
    const root = createProject()
    expect(runVitest(root).status).toBe(0)
    resetExecutions(root)
    rmSync(join(root, 'src/a.ts'))

    const failed = runVitest(root)
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('TIA graph saved')
    expect(
      Object.values((await readGraph(root)).results).some(
        (result) =>
          result.file === 'test/a.test.ts' && result.state === 'failed',
      ),
    ).toBe(true)

    const retried = runVitest(root)
    expect(retried.status).toBe(1)
    expect(retried.output).toContain('1 affected test case in 1 test file')
  })

  test('keeps the old baseline when a selected module fails collection', async () => {
    const root = createProject({
      testA: `import { appendFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { a } from '../src/a'

test('a through a static import', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a\\n')
  expect(a()).toBe('a')
})
`,
    })
    expect(runVitest(root).status).toBe(0)
    const baseline = await readGraph(root)
    resetExecutions(root)
    rmSync(join(root, 'src/a.ts'))

    const failed = runVitest(root)
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('dependency metadata was incomplete')
    expect((await readGraph(root)).updatedAt).toBe(baseline.updatedAt)

    const retried = runVitest(root)
    expect(retried.status).toBe(1)
    expect(retried.output).toContain('1 affected test case in 1 test file')
  })

  test('refuses to save a graph when a test mutates tracked source', () => {
    const root = createProject({
      testA: `import { writeFileSync, appendFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { a } from '../src/a'

test('mutates a tracked source', () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a\\n')
  expect(a()).toBe('a')
  writeFileSync(new URL('../src/a.ts', import.meta.url), "export const a = () => 'changed'\\n")
})
`,
    })

    const result = runVitest(root)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain('project files changed during the run')
    expect(existsSync(join(root, '.tia/state.json'))).toBe(false)
  })

  test('fails before any test when the verification target is misconfigured', () => {
    const root = createProject()

    const result = runVitest(root, ['run'], 20_000, {
      TIA_VERIFICATION_DIRECTORY: join(root, 'verification'),
      TIA_VERIFICATION_PHASE: 'sideways',
    })

    expect(result.status, result.output).not.toBe(0)
    expect(result.output).toContain(
      'TIA_VERIFICATION_PHASE must be selective or full',
    )
    expect(executions(root)).toEqual([])
    expect(existsSync(join(root, '.tia/state.json'))).toBe(false)
  })

  test('composes with an existing setup file and custom reporter', async () => {
    const root = createProject({
      extraFiles: {
        'test/custom-reporter.ts': `import { appendFileSync } from 'node:fs'

export default class CustomReporter {
  onTestRunEnd() {
    appendFileSync(new URL('../custom-reporter.log', import.meta.url), 'done\\n')
  }
}
`,
        'test/setup.ts': `import { appendFileSync } from 'node:fs'
appendFileSync(new URL('../setup.log', import.meta.url), 'setup\\n')
`,
      },
      testConfig:
        "setupFiles: './test/setup.ts', reporters: ['./test/custom-reporter.ts'],",
    })

    const result = runVitest(root)
    expect(result.status, result.output).toBe(0)
    expect(
      readFileSync(join(root, 'setup.log'), 'utf8').trim().split('\n'),
    ).toHaveLength(2)
    expect(readFileSync(join(root, 'custom-reporter.log'), 'utf8')).toBe(
      'done\n',
    )
    expect((await readGraph(root)).edges['test/a.test.ts']).toContain(
      'src/a.ts',
    )
  })

  test('loads through the package exports used by consumers', async () => {
    const root = createProject({ packageImport: true })

    const result = runVitest(root)
    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect((await readGraph(root)).edges['test/a.test.ts']).toContain(
      'src/a.ts',
    )
  })

  test('loads through package exports from a CommonJS-configured project', async () => {
    const root = createProject({ packageImport: true })
    writeFileSync(join(root, 'package.json'), '{"private":true}\n')
    git(root, ['add', 'package.json'])
    git(root, ['commit', '-qm', 'use CommonJS package mode'])

    const result = runVitest(root)
    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect((await readGraph(root)).edges['test/a.test.ts']).toContain(
      'src/a.ts',
    )
  })

  // jsdom 30 needs Node 22.22.
  test.skipIf(!nodeAtLeast('22.22.0'))(
    'loads a linked package setup inside a jsdom project',
    async () => {
      const root = createProject({
        linkPackage: true,
        testA: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { a } from '../src/a'

test('a in jsdom', async () => {
  appendFileSync('executions.log', 'a\\n')
  expect(document.body).toBeTruthy()
  expect(a()).toBe('a')
})
`,
        testB: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { b } from '../src/b'

test('b in jsdom', async () => {
  appendFileSync('executions.log', 'b\\n')
  expect(document.documentElement).toBeTruthy()
  expect(b()).toBe('b')
})
`,
        testConfig: "environment: 'jsdom',",
      })

      const initial = runVitest(root)
      expect(initial.status, initial.output).toBe(0)
      expect(executions(root).sort()).toEqual(['a', 'b'])
      expect((await readGraph(root)).edges['test/a.test.ts']).toContain(
        'src/a.ts',
      )
      expect(initial.output).not.toContain('Cannot find module')
    },
  )

  test('records sequential and concurrent dependencies per test case', async () => {
    const root = createProject({
      extraFiles: {
        'src/shared.ts': "export const shared = 'shared'\n",
      },
      testA: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { shared } from '../src/shared'

test('sequential a', async () => {
  appendFileSync('executions.log', 'sequential-a\\n')
  const { a } = await import('../src/a')
  expect(a()).toBe('a')
  expect(shared).toBe('shared')
})

test('sequential b', async () => {
  appendFileSync('executions.log', 'sequential-b\\n')
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
  expect(shared).toBe('shared')
})

test.skip('skipped case', async () => {})
`,
      testB: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test.concurrent('concurrent a', async () => {
  appendFileSync('executions.log', 'concurrent-a\\n')
  await Promise.resolve()
  const { a } = await import('../src/a')
  expect(a()).toBe('a')
})

test.concurrent('concurrent b', async () => {
  appendFileSync('executions.log', 'concurrent-b\\n')
  await Promise.resolve()
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
})
`,
    })

    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    const graph = await readGraph(root)
    const edgeFor = (name: string) => {
      const result = Object.values(graph.results).find(
        (candidate) => candidate.fullName === name,
      )
      expect(result, `missing result for ${name}`).toBeDefined()
      return graph.testEdges[result!.id]
    }

    expect(edgeFor('sequential a')?.files).toEqual(
      expect.arrayContaining(['src/a.ts', 'src/shared.ts', 'test/a.test.ts']),
    )
    expect(edgeFor('sequential a')?.files).not.toContain('src/b.ts')
    expect(edgeFor('sequential b')?.files).toEqual(
      expect.arrayContaining(['src/b.ts', 'src/shared.ts', 'test/a.test.ts']),
    )
    expect(edgeFor('sequential b')?.files).not.toContain('src/a.ts')
    expect(edgeFor('concurrent a')).toBeUndefined()
    expect(edgeFor('concurrent b')).toBeUndefined()
    expect(edgeFor('skipped case')).toBeUndefined()

    resetExecutions(root)
    const cached = runVitest(root)
    expect(cached.status, cached.output).toBe(0)
    expect(executions(root)).toEqual([])

    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root).sort()).toEqual([
      'concurrent-a',
      'concurrent-b',
      'sequential-a',
    ])
    expect(replay.output).toContain('1 whole-file fallback')
  })

  test('records teardown dependencies and reruns failing afterAll hooks', async () => {
    const root = createProject({
      extraFiles: {
        'src/shared.ts': "export const shared = 'original'\n",
      },
      testA: `import { appendFileSync } from 'node:fs'
import { afterAll, expect, test } from 'vitest'

test('teardown owner', async () => {
  appendFileSync('executions.log', 'a\\n')
})

afterAll(async () => {
  appendFileSync('executions.log', 'a-teardown\\n')
  const { shared } = await import('../src/shared')
  if (process.env.TIACORE_FAIL_TEARDOWN === '1') {
    expect(shared).toBe('original')
  }
})
`,
      testB: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('shared consumer', async () => {
  appendFileSync('executions.log', 'b\\n')
  const { shared } = await import('../src/shared')
  expect(shared).toBeTruthy()
})
`,
    })

    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect((await readGraph(root)).edges['test/a.test.ts']).toContain(
      'src/shared.ts',
    )

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/shared.ts'),
      "export const shared = 'changed'\n",
    )
    const replay = runVitest(root, ['run'], 20_000, {
      TIACORE_FAIL_TEARDOWN: '1',
    })

    expect(replay.status, replay.output).toBe(1)
    expect(executions(root).sort()).toEqual(['a', 'a-teardown', 'b'])
  })

  test('reruns a whole concurrent file when one cached case failed', () => {
    const root = createProject({
      testA: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test.concurrent('passing peer', async () => {
  appendFileSync('executions.log', 'passing-peer\\n')
  await Promise.resolve()
  expect(true).toBe(true)
})

test.concurrent('failing peer', async () => {
  appendFileSync('executions.log', 'failing-peer\\n')
  await Promise.resolve()
  expect(true).toBe(false)
})
`,
    })

    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(1)
    resetExecutions(root)

    const retry = runVitest(root)
    expect(retry.status, retry.output).toBe(1)
    expect(executions(root).sort()).toEqual(['failing-peer', 'passing-peer'])
    expect(retry.output).toContain('1 whole-file fallback')
  })

  test('runs the full suite for an unknown non-code change', () => {
    const root = createProject({
      extraFiles: {
        'src/styles.css': '.button { color: red }\n',
      },
    })
    expect(runVitest(root).status).toBe(0)
    resetExecutions(root)
    writeFileSync(
      join(root, 'src/styles.css'),
      '.button { color: rebeccapurple }\n',
    )

    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect(replay.output).toContain(
      'changed file is unknown to the graph: src/styles.css',
    )
  })

  test('invalidates the graph after a Vitest configuration change', () => {
    const root = createProject()
    expect(runVitest(root).status).toBe(0)
    resetExecutions(root)
    appendFileSync(join(root, 'vitest.config.ts'), '\n')

    const changed = runVitest(root)
    expect(changed.status, changed.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect(changed.output).toContain('project structure changed')
  })

  test('records and replays through the forks pool', () => {
    const root = createProject()
    const initial = runVitest(root, ['run', '--pool=forks'])
    expect(initial.status, initial.output).toBe(0)
    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const replay = runVitest(root, ['run', '--pool=forks'])
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
    expect(replay.output).toContain('1 cached test result')
  })

  test('selects across two Vitest projects in one root', async () => {
    const root = createProject({
      include: '[]',
      testA: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('a project affected case', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a\\n')
  const { a } = await import('../src/a')
  expect(a()).toBe('a')
})

test('a project cached sibling', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a-sibling\\n')
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
})
`,
      testConfig: `projects: [
      { extends: true, test: { name: 'a-project', include: ['test/a.test.ts'] } },
      { extends: true, test: { name: 'b-project', include: ['test/b.test.ts'] } },
    ],`,
    })
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'a-sibling', 'b'])
    expect(initial.output.match(/TIA recording/g)).toHaveLength(1)
    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root), replay.output).toEqual(['a'])
    expect(replay.output.match(/TIA replay:/g)).toHaveLength(1)
  })

  test('executes only an affected case and preserves its cached sibling', async () => {
    const root = createProject({
      include: "['test/a.test.ts']",
      testA: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('affected a case', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'case-a\\n')
  const { a } = await import('../src/a')
  expect(a()).toBe('a')
})

test('cached b case', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'case-b\\n')
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
})
`,
    })
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    const before = await readGraph(root)
    const cachedResult = Object.values(before.results).find(
      (result) => result.fullName === 'cached b case',
    )
    expect(cachedResult).toBeDefined()
    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root), replay.output).toEqual(['case-a'])
    expect(replay.output).toContain('1 cached test result')

    const after = await readGraph(root)
    expect(after.results[cachedResult!.id]?.state).toBe('passed')
    expect(after.testEdges[cachedResult!.id]).toEqual(
      before.testEdges[cachedResult!.id],
    )
  })

  test('emits replay adapter events for cached results without synthetic tests', () => {
    const root = createProject({
      configImports: "import { appendFileSync } from 'node:fs'",
      pluginOptions: `{
        log: true,
        replayAdapters: [{
          onRunStart(event) {
            appendFileSync(
              '.tia/replay-events.log',
              'start:' + event.mode + ':' + event.baseline.origin + ':' +
                event.decisions.length + '\\n',
            )
          },
          onTestReplayed(event) {
            appendFileSync('.tia/replay-events.log', 'cached:' + event.result.fullName + '\\n')
          },
          onRunComplete(event) {
            appendFileSync(
              '.tia/replay-events.log',
              'complete:' + event.executedTestFiles.length + ':' + event.replayedTests + '\\n',
            )
          },
        }],
      }`,
    })

    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    writeFileSync(join(root, '.tia/replay-events.log'), '')
    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
    expect(replay.output).toContain('TIA baseline: local git graph')
    expect(replay.output).toContain('observed dependency changed: src/a.ts')
    expect(
      readFileSync(join(root, '.tia/replay-events.log'), 'utf8')
        .trim()
        .split('\n'),
    ).toEqual(['start:replay:local:1', 'cached:b', 'complete:1:1'])
  })

  test('reruns only a previously failed case in its file', () => {
    const root = createProject({
      include: "['test/a.test.ts']",
      testA: `import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('cached passing case', () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'pass\\n')
  expect(true).toBe(true)
})

test('persistently failing case', () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'fail\\n')
  expect(true).toBe(false)
})
`,
    })
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(1)
    expect(executions(root).sort()).toEqual(['fail', 'pass'])
    resetExecutions(root)

    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(1)
    expect(executions(root), replay.output).toEqual(['fail'])
    expect(replay.output).toContain('1 cached test result')
  })

  test('restores a portable graph in a different checkout', () => {
    const source = createProject()
    expect(runVitest(source).status).toBe(0)
    const clone = cloneProjectWithGraph(source)

    const unchanged = runVitest(clone)
    expect(unchanged.status, unchanged.output).toBe(0)
    expect(executions(clone)).toEqual([])
    expect(unchanged.output).toContain('no affected test files')

    writeFileSync(join(clone, 'src/a.ts'), "export const a = () => 'a'\n\n")
    const changed = runVitest(clone)
    expect(changed.status, changed.output).toBe(0)
    expect(executions(clone)).toEqual(['a'])
  })

  test('selects a source change committed after the baseline', async () => {
    const root = createProject()
    expect(runVitest(root).status).toBe(0)
    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    git(root, ['add', 'src/a.ts'])
    git(root, ['commit', '-qm', 'change a'])

    const changed = runVitest(root)
    expect(changed.status, changed.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
    expect((await readGraph(root)).baseline.sha).not.toBe('')
  })

  test('reconstructs native coverage from affected and cached test shards', () => {
    const root = createProject()
    expect(runVitest(root).status).toBe(0)
    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const coverage = runVitest(root, ['run', '--coverage'])
    expect(coverage.status, coverage.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
    expect(coverage.output).toContain('TIA replay:')
    expect(coverage.output).toContain(
      'TIA coverage reconstructed: 2 source files',
    )

    const reportPath = join(root, 'coverage/coverage-final.json')
    expect(existsSync(reportPath)).toBe(true)
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<
      string,
      { s: Record<string, number> }
    >
    expect(Object.keys(report).some((file) => file.endsWith('/src/a.ts'))).toBe(
      true,
    )
    expect(Object.keys(report).some((file) => file.endsWith('/src/b.ts'))).toBe(
      true,
    )
    expect(
      Object.values(report).every((file) =>
        Object.values(file.s).some((count) => count > 0),
      ),
    ).toBe(true)

    resetExecutions(root)
    rmSync(join(root, 'coverage'), { recursive: true })
    const cachedOnly = runVitest(root, ['run', '--coverage'])
    expect(cachedOnly.status, cachedOnly.output).toBe(0)
    expect(executions(root)).toEqual([])
    expect(cachedOnly.output).toContain('no affected test files')
    const cachedOnlyReport = JSON.parse(
      readFileSync(reportPath, 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(cachedOnlyReport)).toHaveLength(2)
  })

  test('generates configured coverage reports without Vitest coverage mode', () => {
    const root = createProject({
      pluginOptions: `{
        coverage: {
          reportsDirectory: 'tia-coverage',
          reporters: ['json-summary'],
        },
        log: true,
      }`,
    })

    const result = runVitest(root)
    expect(result.status, result.output).toBe(0)
    expect(result.output).toContain(
      'TIA coverage reconstructed: 2 source files',
    )
    expect(existsSync(join(root, 'tia-coverage/coverage-summary.json'))).toBe(
      true,
    )

    resetExecutions(root)
    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual([])
    expect(replay.output).toContain('no affected test files')
  })

  test('records and replays a filesystem baseline without Git', async () => {
    const root = createProject()
    rmSync(join(root, '.git'), { recursive: true })

    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect((await readGraph(root)).baseline).toMatchObject({
      sha: '',
      source: 'filesystem',
    })

    resetExecutions(root)
    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual([])
    expect(replay.output).toContain('no affected test files')

    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    const changed = runVitest(root)
    expect(changed.status, changed.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
  })

  test('ignores its cache directory even when the user did not gitignore it', () => {
    const root = createProject({
      pluginOptions: "{ cacheDir: 'tia-cache', log: true }",
    })
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(existsSync(join(root, 'tia-cache/state.json'))).toBe(true)
    resetExecutions(root)

    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual([])
    expect(replay.output).toContain('no affected test files')
  })

  test('leaves watch mode on Vitest native selection', async () => {
    const root = createProject()
    const watch = await runVitestUntil(root, ['--watch'], (output) =>
      output.includes('Waiting for file changes'),
    )
    expect(watch.output).toContain('Waiting for file changes')

    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect(watch.output).not.toContain('TIA recording')
    expect(existsSync(join(root, '.tia/state.json'))).toBe(false)
  })
})
