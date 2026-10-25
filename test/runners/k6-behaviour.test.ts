import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createK6Graph,
  discoverK6Suites,
  k6CatalogFingerprint,
  planK6,
  tia,
} from '../../src/runners/k6/index.ts'
import { assertNoLeak } from '../support/leak.ts'
import { legacy } from '../support/legacy.ts'

const fixture = fileURLToPath(
  new URL('../fixtures/k6-project', import.meta.url),
)
const fakeRunner = fileURLToPath(
  new URL('../fixtures/fake-adapter-runner.mjs', import.meta.url),
)
const old = await legacy<typeof import('../../src/runners/k6/index.ts')>(
  'adapters/k6/index.js',
)
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tiacore-k6-project-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const where = (root: string) => ({
  profiles: 'k6/profiles',
  project: 'p',
  root,
})

function runner(root: string, extra: Record<string, unknown> = {}) {
  return tia({
    changes: [],
    command: process.execPath,
    commandArguments: [fakeRunner],
    currentEnvironmentFingerprint: 'env',
    environment: { TIACORE_FAKE_RUNNER_LOG: join(root, 'executions.log') },
    ...where(root),
    ...extra,
  })
}

async function recorded(root: string) {
  const suites = await discoverK6Suites(where(root))
  return createK6Graph(root, { environmentFingerprint: 'env', suites })
}

describe('k6 against 1.x', () => {
  test('discovery, fingerprint and graph match byte for byte', async () => {
    const options = {
      profiles: 'k6/profiles',
      project: 'fixture',
      root: fixture,
    }
    const suites = await discoverK6Suites(options)
    expect(suites).toEqual(await old.discoverK6Suites(options))
    expect(JSON.stringify(suites)).toBe(
      JSON.stringify(await old.discoverK6Suites(options)),
    )
    expect(await k6CatalogFingerprint(suites)).toBe(
      await old.k6CatalogFingerprint(suites),
    )
    const graph = await createK6Graph(fixture, {
      environmentFingerprint: 'env',
      suites,
    })
    expect(JSON.stringify(graph)).toBe(
      JSON.stringify(
        await old.createK6Graph(fixture, {
          environmentFingerprint: 'env',
          suites,
        }),
      ),
    )
  })
})

describe('k6 discovery', () => {
  test('is not recursive, skips dot files and tolerates a missing directory', async () => {
    const root = await project({
      'k6/profiles/a.js': '',
      'k6/profiles/.hidden.js': '',
      'k6/profiles/sub/deep.js': '',
      'k6/profiles/notes.md': '',
    })
    const suites = await discoverK6Suites(where(root))
    expect(suites.map((suite) => suite.file)).toEqual(['k6/profiles/a.js'])
    expect(
      await discoverK6Suites({ ...where(root), profiles: 'nope' }),
    ).toEqual([])
  })

  test('treats every script as a profile and keeps path order', async () => {
    const root = await project({
      'k6/profiles/x.d.ts': '',
      'k6/profiles/smoke.test.js': '',
      'k6/profiles/smoke.js': '',
    })
    const suites = await discoverK6Suites(where(root))
    expect(suites.map((suite) => suite.profile)).toEqual([
      'smoke',
      'smoke.test',
      'x.d',
    ])
    expect(Object.keys(suites[0] ?? {})).toEqual([
      'adapter',
      'file',
      'id',
      'profile',
      'project',
      'resourceLocks',
    ])
  })
})

describe('k6 imports', () => {
  test('follows imports transitively and terminates on cycles', async () => {
    const root = await project({
      'k6/profiles/a.js': "import '../lib/b.js'",
      'k6/lib/b.js': "import './c.js'",
      'k6/lib/c.js': "import './b.js'",
    })
    const graph = await recorded(root)
    expect(
      graph.observations.map(({ confidence, kind, source }) => [
        source,
        kind,
        confidence,
      ]),
    ).toEqual([
      ['k6/lib/b.js', 'import', 'exact'],
      ['k6/lib/c.js', 'import', 'exact'],
      ['k6/profiles/a.js', 'configuration', 'exact'],
    ])
  })

  test('resolves only relative specifiers, with extension probing and no index files', async () => {
    const root = await project({
      'k6/profiles/a.js': [
        "import 'k6/http'",
        "import '../lib/noext'",
        "import '../lib/dir'",
        "import '../lib/missing.js'",
        "import 'https://example.com/x.js'",
      ].join('\n'),
      'k6/lib/noext.mjs': '',
      'k6/lib/dir/index.js': '',
    })
    const sources = (await recorded(root)).observations.map(
      (observation) => observation.source,
    )
    expect(sources).toEqual(['k6/lib/noext.mjs', 'k6/profiles/a.js'])
  })

  test('ignores type-only imports and dynamic imports without a literal', async () => {
    const root = await project({
      'k6/profiles/a.ts': [
        "import type { T } from '../lib/types.ts'",
        "export type { U } from '../lib/more.ts'",
        "import { v } from '../lib/value.ts'",
        "export * from '../lib/star.ts'",
        "const lazy = import('../lib/lazy.ts')",
        'const dynamic = import(name)',
        'const glob = import(`../lib/${name}.ts`)',
        'void [v, lazy, dynamic, glob, import.meta.url]',
      ].join('\n'),
      'k6/lib/types.ts': 'export type T = string',
      'k6/lib/more.ts': 'export type U = string',
      'k6/lib/value.ts': 'export const v = 1',
      'k6/lib/star.ts': 'export const s = 1',
      'k6/lib/lazy.ts': 'export const l = 1',
    })
    const sources = (await recorded(root)).observations.map(
      (observation) => observation.source,
    )
    expect(sources).toEqual([
      'k6/lib/lazy.ts',
      'k6/lib/star.ts',
      'k6/lib/value.ts',
      'k6/profiles/a.ts',
    ])
  })

  test('recording a graph still fails on a file that cannot be lexed', async () => {
    const root = await project({ 'k6/profiles/a.js': 'import {' })
    await expect(recorded(root)).rejects.toThrow(/Parse error/u)
  })

  test('rejects an import that leaves the repository', async () => {
    const root = await project({
      'k6/profiles/a.js': "import '../../../outside.js'",
    })
    const outside = join(root, '..', 'outside.js')
    await writeFile(outside, '')
    temporary.push(outside)
    await expect(recorded(root)).rejects.toThrow(
      'TIA protocol paths must be project-relative',
    )
  })
})

describe('k6 planning', () => {
  test('names unknown or ambiguous profiles in the lane', async () => {
    const root = await project({
      'k6/profiles/smoke.js': '',
      'k6/profiles/smoke.ts': '',
      'k6/profiles/load.js': '',
    })
    const base = {
      ...where(root),
      changes: [],
      currentEnvironmentFingerprint: 'env',
      graph: null,
    }
    await expect(
      planK6({ ...base, allowedProfiles: ['nope'] }),
    ).rejects.toThrow('k6 policy names an unknown or duplicate profile')
    await expect(
      planK6({ ...base, allowedProfiles: ['smoke'] }),
    ).rejects.toThrow('k6 policy names an unknown or duplicate profile')
    expect(
      (await planK6({ ...base, allowedProfiles: ['load', 'load'] })).selected,
    ).toEqual(['k6:p:k6/profiles/load.js'])
    expect((await planK6({ ...base, allowedProfiles: [] })).selected).toEqual(
      [],
    )
  })

  test('an application file is unknown to a runner-recorded graph', async () => {
    const root = await project({ 'k6/profiles/a.js': '' })
    const graph = await recorded(root)
    const base = {
      ...where(root),
      changes: ['app/src/Foo.ts'],
      currentEnvironmentFingerprint: 'env',
      graph,
    }
    const full = await planK6(base)
    expect(full).toMatchObject({
      mode: 'full',
      reason: 'changed file is unknown to the impact graph: app/src/Foo.ts',
    })
    expect((await planK6({ ...base, onUnknownChange: 'ignore' })).mode).toBe(
      'skip',
    )
  })
})

describe('k6 runner', () => {
  test('stores the graph under .tia/k6 of the root by default and promotes on skip', async () => {
    const root = await project({ 'k6/profiles/a.js': '' })
    const first = await runner(root).run()
    expect(first.plan.mode).toBe('full')
    const graphPath = join(root, '.tia/k6/graph.json')
    expect(JSON.parse(await readFile(graphPath, 'utf8'))).toMatchObject({
      invalidators: [],
      knownSources: [],
    })
    await rm(graphPath)
    await mkdir(join(root, '.tia/k6'), { recursive: true })
    await writeFile(graphPath, '{not json')
    const second = await runner(root).run()
    expect(second.plan).toMatchObject({
      mode: 'full',
      reason: 'no compatible impact graph found',
    })
    const third = await runner(root).run()
    expect(third.plan.mode).toBe('skip')
    expect(existsSync(graphPath)).toBe(true)
  })

  test('a lane-bounded run promotes a graph of every profile', async () => {
    const root = await project({
      'k6/profiles/smoke.js': '',
      'k6/profiles/load.js': '',
    })
    const result = await runner(root, { allowedProfiles: ['smoke'] }).run()
    expect(result.executions.map((item) => item.suiteId)).toEqual([
      'k6:p:k6/profiles/smoke.js',
    ])
    const graph = JSON.parse(
      await readFile(join(root, '.tia/k6/graph.json'), 'utf8'),
    )
    expect(graph.suites.map((suite: { id: string }) => suite.id)).toEqual([
      'k6:p:k6/profiles/load.js',
      'k6:p:k6/profiles/smoke.js',
    ])
  })

  test('runs every selected profile after one fails and reports the first failure', async () => {
    const root = await project({
      'k6/profiles/a.js': '',
      'k6/profiles/b.js': '',
    })
    const result = await runner(root, {
      environment: {
        TIACORE_FAKE_RUNNER_FAIL: 'a.js',
        TIACORE_FAKE_RUNNER_LOG: join(root, 'executions.log'),
      },
    }).run()
    expect(result).toMatchObject({ status: 7, success: false })
    expect(result.executions).toHaveLength(2)
    expect(
      (await readFile(join(root, 'executions.log'), 'utf8')).trim().split('\n'),
    ).toHaveLength(2)
    expect(existsSync(join(root, '.tia/k6/graph.json'))).toBe(false)
  })

  test('rejects an invalid maxConcurrency before running anything', async () => {
    const root = await project({ 'k6/profiles/a.js': '' })
    await expect(runner(root, { maxConcurrency: 0 }).run()).rejects.toThrow(
      'maxConcurrency must be a positive integer',
    )
    expect(existsSync(join(root, 'executions.log'))).toBe(false)
    expect(existsSync(join(root, '.tia/k6/graph.json'))).toBe(false)
  })

  test('rejects with the spawn error when the command is missing', async () => {
    const root = await project({ 'k6/profiles/a.js': '' })
    await expect(
      tia({
        changes: [],
        command: 'tiacore-no-such-k6',
        currentEnvironmentFingerprint: 'env',
        ...where(root),
      }).run(),
    ).rejects.toThrow(/ENOENT/u)
    expect(existsSync(join(root, '.tia/k6/graph.json'))).toBe(false)
  })

  test('plans a full run before execution when a file cannot be lexed, then forces the next run to be full', async () => {
    const root = await project({
      'k6/profiles/good.js': '',
      'k6/profiles/bad.js': "import { from './x.js'",
    })
    const first = await runner(root).run()
    expect(first.success).toBe(true)
    const log = (await readFile(join(root, 'executions.log'), 'utf8'))
      .trim()
      .split('\n')
    expect(log.sort()).toEqual(['k6/profiles/bad.js', 'k6/profiles/good.js'])
    expect(first.plan.mode).toBe('full')
    expect(first.plan.reason).toMatch(
      /^k6 import analysis failed for k6\/profiles\/bad\.js: Parse error/u,
    )
    expect(
      JSON.parse(await readFile(join(root, '.tia/k6/graph.json'), 'utf8'))
        .complete,
    ).toBe(false)
    const second = await runner(root).run()
    expect(second.plan.mode).toBe('full')
  })

  test('does not leak across repeated runs', async () => {
    const root = await project({ 'k6/profiles/a.js': '' })
    const { bytesPerOperation } = await assertNoLeak(
      () => runner(root, { forceFull: true }).run(),
      { bytesPerOperation: 20_000, iterations: 10 },
    )
    expect(bytesPerOperation).toBeLessThan(20_000)
  }, 60_000)
})
