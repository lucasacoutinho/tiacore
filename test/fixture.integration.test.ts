import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  executions,
  readGraph,
  resetExecutions,
  runCommand,
  runVitest,
  runVitestAsync,
} from './helpers/integration-project.js'
import type { TiaRuntimeGraph } from '../src/shared/types.js'

afterEach(() => {
  cleanupProjects()
})

describe('runnable fixture projects', () => {
  test('matches native include, exclude, and zero-hit coverage semantics', () => {
    const nativeRoot = createFixtureProject('coverage-fidelity')
    const native = runVitest(
      nativeRoot,
      ['run'],
      20_000,
      { TIA_COVERAGE_MODE: 'native' },
    )
    expect(native.status, native.output).toBe(0)

    const tiaRoot = createFixtureProject('coverage-fidelity')
    const reconstructed = runVitest(tiaRoot)
    expect(reconstructed.status, reconstructed.output).toBe(0)

    const summaries = [nativeRoot, tiaRoot].map((root) => {
      const value = JSON.parse(
        readFileSync(
          join(root, 'coverage/coverage-summary.json'),
          'utf8',
        ),
      ) as Record<
        string,
        Record<
          'branches' | 'functions' | 'lines' | 'statements',
          { pct: number }
        >
      >

      return Object.fromEntries(
        Object.entries(value)
          .filter(([file]) => file !== 'total')
          .map(([file, metrics]) => [
            file.split(/[\\/]/).at(-1),
            Object.fromEntries(
              Object.entries(metrics).map(([name, metric]) => [
                name,
                metric.pct,
              ]),
            ),
          ]),
      )
    })

    expect(Object.keys(summaries[0]!).sort()).toEqual([
      'covered.ts',
      'uncovered.ts',
    ])
    expect(summaries[1]).toEqual(summaries[0])
    expect(summaries[1]?.['uncovered.ts']).toEqual({
      branches: 100,
      functions: 0,
      lines: 0,
      statements: 0,
    })
    expect(
      readFileSync(
        join(tiaRoot, 'coverage/html/index.html'),
        'utf8',
      ),
    ).toContain("status-line medium")
  })

  test('honors coverage cleaning and failed-test reporting lifecycle', () => {
    const root = createFixtureProject('coverage-fidelity')
    mkdirSync(join(root, 'coverage'), { recursive: true })
    writeFileSync(join(root, 'coverage/stale.txt'), 'stale')

    const clean = runVitest(root)
    expect(clean.status, clean.output).toBe(0)
    expect(existsSync(join(root, 'coverage/stale.txt'))).toBe(false)

    writeFileSync(join(root, 'coverage/keep.txt'), 'keep')
    const preserve = runVitest(
      root,
      ['run'],
      20_000,
      { TIA_COVERAGE_CLEAN: '0' },
    )
    expect(preserve.status, preserve.output).toBe(0)
    expect(existsSync(join(root, 'coverage/keep.txt'))).toBe(true)

    const skippedRoot = createFixtureProject('coverage-fidelity')
    const skipped = runVitest(
      skippedRoot,
      ['run'],
      20_000,
      { TIA_FIXTURE_FAIL: '1' },
    )
    expect(skipped.status, skipped.output).toBe(1)
    expect(
      existsSync(join(skippedRoot, 'coverage/coverage-final.json')),
    ).toBe(false)

    const reportedRoot = createFixtureProject('coverage-fidelity')
    const reported = runVitest(
      reportedRoot,
      ['run'],
      20_000,
      {
        TIA_COVERAGE_REPORT_ON_FAILURE: '1',
        TIA_FIXTURE_FAIL: '1',
      },
    )
    expect(reported.status, reported.output).toBe(1)
    expect(
      existsSync(join(reportedRoot, 'coverage/coverage-final.json')),
    ).toBe(true)
  })

  test('fails safely for subprocess-only dependencies and reports them as zero-hit', () => {
    const root = createFixtureProject('subprocess-policy')
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['child', 'sibling'])

    const graph = readGraph(root)
    const childResult = Object.values(graph.results).find((result) =>
      result.fullName.includes('external Node process'),
    )
    expect(childResult).toBeDefined()
    expect(graph.testEdges[childResult!.id]?.files).not.toContain(
      'src/child.mjs',
    )

    const report = JSON.parse(
      readFileSync(
        join(root, 'coverage/coverage-final.json'),
        'utf8',
      ),
    ) as Record<string, { s: Record<string, number> }>
    const childCoverage = Object.entries(report).find(([file]) =>
      file.endsWith('/src/child.mjs'),
    )?.[1]
    expect(childCoverage).toBeDefined()
    expect(Object.values(childCoverage!.s)).toEqual([0])

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/child.mjs'),
      "process.stdout.write('child-v1')\n// external change\n",
    )
    const changed = runVitest(root)
    expect(changed.status, changed.output).toBe(0)
    expect(changed.output).toContain('changed file is unknown')
    expect(executions(root).sort()).toEqual(['child', 'sibling'])
  })

  test('selects a subprocess-owning test through an explicit process mapping', () => {
    const root = createFixtureProject('subprocess-policy')
    const environment = { TIA_SUBPROCESS_MAP: '1' }
    const initial = runVitest(root, ['run'], 20_000, environment)
    expect(initial.status, initial.output).toBe(0)

    const graph = readGraph(root)
    const childResult = Object.values(graph.results).find((result) =>
      result.fullName.includes('external Node process'),
    )
    expect(childResult).toBeDefined()
    expect(graph.testEdges[childResult!.id]?.files).toContain('src/child.mjs')

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/child.mjs'),
      "process.stdout.write('child-v1')\n// mapped external change\n",
    )
    const changed = runVitest(root, ['run'], 20_000, environment)
    expect(changed.status, changed.output).toBe(0)
    expect(changed.output).toContain(
      '1 affected test case in 1 test file; 1 cached test result',
    )
    expect(executions(root)).toEqual(['child'])
  })

  test('preserves native coverage reporter tuples and enforces cached thresholds', () => {
    const root = createFixtureProject('coverage-native')
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root)).toEqual(['classify'])
    expect(
      existsSync(join(root, 'coverage/tuple-summary.json')),
      initial.output,
    ).toBe(true)
    expect(
      existsSync(join(root, 'coverage/coverage-summary.json')),
    ).toBe(false)

    resetExecutions(root)
    const strict = runVitest(
      root,
      ['run'],
      20_000,
      { TIA_STRICT_COVERAGE: '1' },
    )
    expect(strict.status, strict.output).toBe(1)
    expect(executions(root)).toEqual([])
    expect(strict.output).toContain('no affected test files')
    expect(strict.output).toContain(
      'does not meet global threshold (100%) for src/classify.ts',
    )
    expect(strict.output).toContain(
      'does not meet "src/classify.ts" threshold (100%) for src/classify.ts',
    )
  })

  test('sends detached cached cases only to opted-in reporters', () => {
    const root = createFixtureProject('reporter-replay')
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])

    resetExecutions(root)
    writeFileSync(join(root, 'reporter-events.log'), '')
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    const replay = runVitest(root)
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual(['a'])

    const events = readFileSync(
      join(root, 'reporter-events.log'),
      'utf8',
    ).trim().split('\n')
    expect(events).toEqual(
      expect.arrayContaining([
        'ready:cached:reporter case b:passed',
        'result:cached:reporter case b:passed',
        'ready:live:reporter case a:passed',
        'result:live:reporter case a:passed',
      ]),
    )
    expect(replay.output).toMatch(/Tests\s+1 passed \(1\)/)
    expect(replay.output).toContain('1 cached test result')
  })

  test('tracks real SQLite table and EJS view dependencies per test', () => {
    const root = createFixtureProject('framework-edges')
    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual([
      'database-order',
      'database-user',
      'view-admin',
      'view-user',
    ])

    const graph = readGraph(root)
    const byName = (name: string) =>
      Object.values(graph.results).find((result) =>
        result.fullName.includes(name),
      )!
    expect(
      graph.testEdges[byName('users table').id]?.files,
    ).toContain('migrations/001_users.sql')
    expect(
      graph.testEdges[byName('users table').id]?.files,
    ).not.toContain('migrations/002_orders.sql')
    expect(
      graph.testEdges[byName('orders table').id]?.files,
    ).toContain('migrations/002_orders.sql')
    expect(
      graph.testEdges[byName('user EJS').id]?.files,
    ).toContain('views/user.ejs')
    expect(
      graph.testEdges[byName('admin EJS').id]?.files,
    ).toContain('views/admin.ejs')

    resetExecutions(root)
    writeFileSync(
      join(root, 'migrations/001_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER);\\n',
    )
    const databaseReplay = runVitest(root)
    expect(databaseReplay.status, databaseReplay.output).toBe(0)
    expect(executions(root)).toEqual(['database-user'])

    resetExecutions(root)
    writeFileSync(
      join(root, 'views/user.ejs'),
      '<h1>Hello <%= name %>!</h1>\\n',
    )
    const viewReplay = runVitest(root)
    expect(viewReplay.status, viewReplay.output).toBe(0)
    expect(executions(root)).toEqual(['view-user'])
  })

  test('merges simultaneous local Vitest shards and reconstructs full coverage', async () => {
    const root = createFixtureProject('sharded-vitest')
    const [first, second] = await Promise.all([
      runVitestAsync(
        root,
        ['run', '--shard=1/2'],
        20_000,
        { TIA_FRESH: '1', TIA_SHARD_GROUP: 'local-suite' },
      ),
      runVitestAsync(
        root,
        ['run', '--shard=2/2'],
        20_000,
        { TIA_FRESH: '1', TIA_SHARD_GROUP: 'local-suite' },
      ),
    ])
    expect(first.status, first.output).toBe(0)
    expect(second.status, second.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    const groups = readdirSync(join(root, '.tia/fragments'))
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    const fragments = ['1-of-2', '2-of-2'].map((partition) =>
      JSON.parse(
        readFileSync(
          join(
            root,
            '.tia/fragments',
            group,
            partition,
            'graph.json',
          ),
          'utf8',
        ),
      ) as TiaRuntimeGraph,
    )
    expect(fragments.map((graph) => graph.partition)).toEqual([
      { group: 'local-suite', index: 1, total: 2 },
      { group: 'local-suite', index: 2, total: 2 },
    ])
    expect(fragments.every((graph) => !graph.complete)).toBe(true)
    expect(readGraph(root).complete).toBe(true)

    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")
    const replay = runVitest(
      root,
      ['run', '--coverage'],
      20_000,
    )
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
    const report = JSON.parse(
      readFileSync(join(root, 'coverage/coverage-final.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(report).some((file) => file.endsWith('/src/a.ts'))).toBe(
      true,
    )
    expect(Object.keys(report).some((file) => file.endsWith('/src/b.ts'))).toBe(
      true,
    )
  })

  test('does not combine missing or differently grouped local shards', async () => {
    const root = createFixtureProject('sharded-vitest')
    const first = await runVitestAsync(
      root,
      ['run', '--shard=1/2'],
      20_000,
      { TIA_FRESH: '1', TIA_SHARD_GROUP: 'first-run' },
    )
    expect(first.status, first.output).toBe(0)
    expect(existsSync(join(root, '.tia/graph.json'))).toBe(false)

    const mixed = await runVitestAsync(
      root,
      ['run', '--shard=2/2'],
      20_000,
      { TIA_FRESH: '1', TIA_SHARD_GROUP: 'second-run' },
    )
    expect(mixed.status, mixed.output).toBe(0)
    expect(existsSync(join(root, '.tia/graph.json'))).toBe(false)
  })

  test('restores CI-downloaded shard directories without a platform API', async () => {
    const root = createFixtureProject('sharded-vitest')
    const results = await Promise.all([
      runVitestAsync(
        root,
        ['run', '--shard=1/2'],
        20_000,
        { TIA_FRESH: '1', TIA_SHARD_GROUP: 'portable-ci-run' },
      ),
      runVitestAsync(
        root,
        ['run', '--shard=2/2'],
        20_000,
        { TIA_FRESH: '1', TIA_SHARD_GROUP: 'portable-ci-run' },
      ),
    ])
    expect(results.every((result) => result.status === 0)).toBe(true)

    const group = readdirSync(join(root, '.tia/fragments'))[0]!
    for (const partition of ['1-of-2', '2-of-2']) {
      const destination = join(
        root,
        '.tia-artifacts',
        partition,
      )
      mkdirSync(destination, { recursive: true })
      cpSync(
        join(
          root,
          '.tia/fragments',
          group,
          partition,
          'graph.json',
        ),
        join(destination, 'graph.json'),
      )
    }
    rmSync(join(root, '.tia'), { force: true, recursive: true })
    resetExecutions(root)

    const restored = runVitest(
      root,
      ['run'],
      20_000,
      { TIA_FILESYSTEM_ARTIFACTS: '1' },
    )
    expect(restored.status, restored.output).toBe(0)
    expect(restored.output).toContain(
      'TIA restored artifact',
    )
    expect(restored.output).toContain(
      'from filesystem artifacts',
    )
    expect(executions(root)).toEqual([])
    expect(readGraph(root).complete).toBe(true)
  })

  test('selects exact bun:test cases and falls back for unknown changes', () => {
    const root = createFixtureProject('bun-runner')

    const initial = runCommand(root, 'bun', ['run-tia.ts'])
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['bun-a', 'bun-b'])
    expect(initial.output).toContain('TIA bun recording full-suite baseline')
    const graph = readGraph(root, 'bun')
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

  test('selects exact node:test cases and reruns cached failures', async () => {
    const root = createFixtureProject('node-runner')

    const initial = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual(['node-a', 'node-b'])
    expect(initial.output).toContain('TIA node recording full-suite baseline')
    const initialGraph = readGraph(root, 'node')
    const aResult = Object.values(initialGraph.results).find(
      (result) => result.fullName === 'node case a',
    )
    const bResult = Object.values(initialGraph.results).find(
      (result) => result.fullName === 'node case b',
    )
    const skippedResult = Object.values(initialGraph.results).find(
      (result) => result.fullName === 'node skipped case',
    )
    expect(initialGraph.testEdges[aResult!.id]?.files).toContain('src/a.mjs')
    expect(initialGraph.testEdges[aResult!.id]?.files).not.toContain('src/b.mjs')
    expect(initialGraph.testEdges[bResult!.id]?.files).toContain('src/b.mjs')
    expect(skippedResult?.state).toBe('skipped')

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/a.mjs'),
      "export const a = () => 'broken'\n",
    )
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
    expect(
      Object.values(readGraph(root, 'node').results),
    ).toEqual([
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
    const result = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      20_000,
      { TIACORE_NODE_DISCOVERY_HOOKS: '0' },
    )
    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['node-a', 'node-b'])

    const graph = readGraph(root, 'node')
    const caseA = Object.values(graph.results).find(
      (cached) => cached.fullName === 'node case a',
    )!
    expect(graph.testEdges[caseA.id]?.files).toEqual(
      expect.arrayContaining(['src/a.mjs', 'src/b.mjs']),
    )
  })

  test('discovers and replays a nested node:test name without running it twice', async () => {
    const root = createFixtureProject('node-nested')
    const initial = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(executions(root).sort()).toEqual([
      'node-commonjs',
      'node-nested',
    ])
    expect(initial.status, initial.output).toBe(0)
    expect(
      Object.values(readGraph(root, 'node').results).map(
        (result) => result.fullName,
      ),
    ).toEqual(
      expect.arrayContaining([
        'CommonJS case',
        'account suite nested case',
      ]),
    )

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/a.mjs'),
      "export const a = () => 'a'\n\n",
    )
    const replay = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(replay.status, replay.output).toBe(0)
    expect(executions(root)).toEqual(['node-nested'])
  })

  test('selects React Testing Library suites and their imported assets', () => {
    const root = createFixtureProject('react-jsdom')

    const initial = runVitest(root)
    expect(initial.status, initial.output).toBe(0)
    expect(executions(root).sort()).toEqual([
      'badge',
      'button',
      'lazy-panel',
    ])
    expect(readGraph(root).edges['test/Button.test.tsx']).toEqual(
      expect.arrayContaining([
        'src/Button.module.css',
        'src/Button.tsx',
        'src/save.svg',
      ]),
    )
    expect(readGraph(root).edges['test/Badge.test.tsx']).toContain(
      'src/badge.json',
    )
    expect(readGraph(root).edges['test/LazyPanel.test.tsx']).toContain(
      'src/LazyPanel.tsx',
    )

    resetExecutions(root)
    appendFileSync(join(root, 'src/LazyPanel.tsx'), '\n')
    const lazyReplay = runVitest(root)
    expect(lazyReplay.status, lazyReplay.output).toBe(0)
    expect(executions(root), lazyReplay.output).toEqual(['lazy-panel'])
    expect(lazyReplay.output).toContain('2 cached test results')

    resetExecutions(root)
    appendFileSync(join(root, 'src/Button.tsx'), '\n')
    const componentReplay = runVitest(root)
    expect(componentReplay.status, componentReplay.output).toBe(0)
    expect(executions(root), componentReplay.output).toEqual(['button'])
    expect(componentReplay.output).toContain('2 cached test results')

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/Button.module.css'),
      '.primary { color: rebeccapurple; }\n',
    )
    const cssReplay = runVitest(root)
    expect(cssReplay.status, cssReplay.output).toBe(0)
    expect(executions(root), cssReplay.output).toEqual(['button'])

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/badge.json'),
      '{\n  "label": "ready-copy"\n}\n\n',
    )
    const jsonReplay = runVitest(root)
    expect(jsonReplay.status, jsonReplay.output).toBe(0)
    expect(executions(root), jsonReplay.output).toEqual(['badge'])

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/save.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h2v2z"/></svg>\n',
    )
    const svgReplay = runVitest(root)
    expect(svgReplay.status, svgReplay.output).toBe(0)
    expect(executions(root), svgReplay.output).toEqual(['button'])

    resetExecutions(root)
    appendFileSync(join(root, 'src/NeverRendered.tsx'), '\n')
    const unknownLazyChunk = runVitest(root)
    expect(unknownLazyChunk.status, unknownLazyChunk.output).toBe(0)
    expect(executions(root).sort()).toEqual([
      'badge',
      'button',
      'lazy-panel',
    ])
    expect(unknownLazyChunk.output).toContain(
      'changed file is unknown to the graph: src/NeverRendered.tsx',
    )
  })

  test(
    'selects one Browser Mode case in a mixed Node/browser suite',
    { retry: 1, timeout: 45_000 },
    () => {
      const root = createFixtureProject('mixed-browser')

      const initial = runVitest(root, ['run'], 30_000)
      expect(initial.status, initial.output).toBe(0)
      expect(executions(root).sort()).toEqual([
        'browser-a-sibling',
        'browser-b',
        'node-a',
      ])
      expect(initial.output).toContain('TIA recording full-suite baseline')

      resetExecutions(root)
      writeFileSync(join(root, 'src/b.css'), '.browser-b { color: blue; }\n')
      const replay = runVitest(root, ['run'], 30_000)
      expect(replay.status, replay.output).toBe(0)
      expect(executions(root), replay.output).toEqual(['browser-b'])
      expect(replay.output).toContain(
        'TIA replay: 1 affected test case in 1 test file',
      )
      expect(replay.output).toContain('2 cached test results')

      resetExecutions(root)
      rmSync(join(root, 'coverage'), { force: true, recursive: true })
      const coverage = runVitest(root, ['run', '--coverage'], 30_000)
      expect(coverage.status, coverage.output).toBe(0)
      expect(executions(root)).toEqual([])
      const report = JSON.parse(
        readFileSync(join(root, 'coverage/coverage-final.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(Object.keys(report).some((file) => file.endsWith('/src/a.ts'))).toBe(
        true,
      )
      expect(Object.keys(report).some((file) => file.endsWith('/src/b.ts'))).toBe(
        true,
      )
    },
  )
})
