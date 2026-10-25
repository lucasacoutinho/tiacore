import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createMaestroGraph,
  discoverMaestroSuites,
  maestroCatalogFingerprint,
  planMaestro,
  tia,
} from '../../src/runners/maestro/index.ts'
import { legacy } from '../support/legacy.ts'

const fixture = fileURLToPath(
  new URL('../fixtures/maestro-project', import.meta.url),
)
const fakeRunner = fileURLToPath(
  new URL('../fixtures/fake-adapter-runner.mjs', import.meta.url),
)
const old = await legacy<typeof import('../../src/runners/maestro/index.ts')>(
  'adapters/maestro/index.js',
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
  const root = await mkdtemp(join(tmpdir(), 'tiacore-maestro-project-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const flow = (name: string, ...run: string[]) =>
  `appId: app\nname: ${name}\n---\n${run.map((file) => `- runFlow: ${file}`).join('\n')}\n- launchApp\n`

const where = (root: string) => ({ flows: 'e2e', project: 'p', root })

describe('Maestro against 1.x', () => {
  test('discovery, fingerprint and graph match byte for byte on the fixture', async () => {
    const options = { flows: 'e2e', project: 'fixture', root: fixture }
    const suites = await discoverMaestroSuites(options)
    expect(JSON.stringify(suites)).toBe(
      JSON.stringify(await old.discoverMaestroSuites(options)),
    )
    expect(maestroCatalogFingerprint(suites)).toBe(
      old.maestroCatalogFingerprint(suites),
    )
    expect(
      JSON.stringify(
        createMaestroGraph({ environmentFingerprint: 'env', suites }),
      ),
    ).toBe(
      JSON.stringify(
        old.createMaestroGraph({ environmentFingerprint: 'env', suites }),
      ),
    )
  })
})

describe('Maestro discovery', () => {
  test('reads every YAML document: single-document files are scanned', async () => {
    const root = await project({
      'e2e/login.yaml': 'appId: app\nname: Login\n---\n- launchApp\n',
      'e2e/single.yml': '- runFlow: login.yaml\n- launchApp\n',
    })
    const suites = await discoverMaestroSuites(where(root))
    expect(
      suites.find((suite) => suite.file === 'e2e/single.yml'),
    ).toMatchObject({
      dependsOn: ['maestro:p:e2e/login.yaml'],
      name: 'e2e/single.yml',
    })
    expect(
      (await old.discoverMaestroSuites(where(root))).find(
        (suite) => suite.file === 'e2e/single.yml',
      )?.dependsOn,
    ).toEqual([])
  })

  test('config.yaml at the flow root is not a suite', async () => {
    const root = await project({
      'e2e/config.yaml': 'executionOrder:\n  continueOnFailure: false\n',
      'e2e/config.yml': 'flows:\n  - "*"\n',
      'e2e/nested/config.yaml': 'appId: app\n---\n- launchApp\n',
      'e2e/login.yaml': flow('Login'),
    })
    expect(
      (await discoverMaestroSuites(where(root))).map((suite) => suite.file),
    ).toEqual(['e2e/login.yaml', 'e2e/nested/config.yaml'])
  })

  test('finds object form runFlow at any depth and drops unknown targets', async () => {
    const root = await project({
      'e2e/a.yaml':
        'appId: app\n---\n- repeat:\n    times: 2\n    commands:\n      - runFlow:\n          file: b.yaml\n- runFlow: ../missing.yaml\n',
      'e2e/b.yaml': flow('B'),
    })
    expect(
      (await discoverMaestroSuites(where(root))).find(
        (suite) => suite.file === 'e2e/a.yaml',
      )?.dependsOn,
    ).toEqual(['maestro:p:e2e/b.yaml'])
  })

  test('a runFlow target outside the repository aborts discovery', async () => {
    const root = await project({ 'e2e/a.yaml': flow('A', '../../shared.yaml') })
    await expect(discoverMaestroSuites(where(root))).rejects.toThrow(
      'TIA protocol paths must be project-relative: ../shared.yaml',
    )
  })

  test('invalid YAML names the file', async () => {
    const root = await project({ 'e2e/bad.yaml': 'appId: [\n' })
    await expect(discoverMaestroSuites(where(root))).rejects.toThrow(
      new RegExp(`invalid Maestro flow ${join(root, 'e2e/bad.yaml')}: `, 'u'),
    )
  })

  test('metadata falls back safely', async () => {
    const root = await project({
      'e2e/empty.yaml': '',
      'e2e/blank.yaml':
        "name: '   '\ntags: [b, 1, a, true]\nappId: 5\n---\n- launchApp\n",
      'e2e/.hidden.yaml': '',
    })
    const suites = await discoverMaestroSuites(where(root))
    expect(suites.map((suite) => [suite.file, suite.name, suite.tags])).toEqual(
      [
        ['e2e/blank.yaml', 'e2e/blank.yaml', ['a', 'b']],
        ['e2e/empty.yaml', 'e2e/empty.yaml', []],
      ],
    )
    expect(suites[0]).not.toHaveProperty('appId')
    expect(Object.keys(suites[0] ?? {})).toEqual([
      'adapter',
      'file',
      'id',
      'name',
      'project',
      'resourceLocks',
      'tags',
      'dependsOn',
    ])
  })

  test('tag filters apply before dependency resolution and exclusion wins', async () => {
    const root = await project({
      'e2e/login.yaml': 'appId: app\ntags: [health]\n---\n- launchApp\n',
      'e2e/settings.yaml':
        'appId: app\ntags: [health, settings]\n---\n- runFlow: login.yaml\n',
    })
    const only = await discoverMaestroSuites({
      ...where(root),
      includeTags: ['settings'],
    })
    expect(only.map((suite) => [suite.file, suite.dependsOn])).toEqual([
      ['e2e/settings.yaml', []],
    ])
    const excluded = await discoverMaestroSuites({
      ...where(root),
      excludeTags: ['settings'],
      includeTags: ['health'],
    })
    expect(excluded.map((suite) => suite.file)).toEqual(['e2e/login.yaml'])
  })
})

describe('Maestro graph', () => {
  test('a changed subflow selects every flow that runs it, however deep', async () => {
    const root = await project({
      'e2e/a.yaml': flow('A', 'b.yaml'),
      'e2e/b.yaml': flow('B', 'c.yaml'),
      'e2e/c.yaml': flow('C'),
      'e2e/other.yaml': flow('Other'),
    })
    const suites = await discoverMaestroSuites(where(root))
    const graph = createMaestroGraph({ environmentFingerprint: 'env', suites })
    const plan = await planMaestro({
      ...where(root),
      changes: ['e2e/c.yaml'],
      currentEnvironmentFingerprint: 'env',
      graph,
    })
    expect(plan.selected).toEqual([
      'maestro:p:e2e/a.yaml',
      'maestro:p:e2e/b.yaml',
      'maestro:p:e2e/c.yaml',
    ])
    const below = await planMaestro({
      ...where(root),
      changes: ['e2e/a.yaml'],
      currentEnvironmentFingerprint: 'env',
      graph,
    })
    expect(below.selected).toEqual([
      'maestro:p:e2e/a.yaml',
      'maestro:p:e2e/b.yaml',
      'maestro:p:e2e/c.yaml',
    ])
  })

  test('flow cycles and self references terminate', async () => {
    const root = await project({
      'e2e/a.yaml': flow('A', 'b.yaml', 'a.yaml'),
      'e2e/b.yaml': flow('B', 'a.yaml'),
    })
    const suites = await discoverMaestroSuites(where(root))
    const graph = createMaestroGraph({ environmentFingerprint: 'env', suites })
    expect(
      graph.observations.map((item) => [item.suiteId, item.source, item.kind]),
    ).toEqual([
      ['maestro:p:e2e/a.yaml', 'e2e/a.yaml', 'configuration'],
      ['maestro:p:e2e/a.yaml', 'e2e/b.yaml', 'fixture'],
      ['maestro:p:e2e/b.yaml', 'e2e/b.yaml', 'configuration'],
      ['maestro:p:e2e/b.yaml', 'e2e/a.yaml', 'fixture'],
    ])
    const plan = await planMaestro({
      ...where(root),
      changes: ['e2e/a.yaml'],
      currentEnvironmentFingerprint: 'env',
      graph,
    })
    expect(plan.selected).toHaveLength(2)
  })

  test('a runner-written graph knows nothing outside the flows', async () => {
    const root = await project({ 'e2e/a.yaml': flow('A') })
    const suites = await discoverMaestroSuites(where(root))
    const graph = createMaestroGraph({ environmentFingerprint: 'env', suites })
    expect(graph).toMatchObject({
      complete: true,
      invalidators: [],
      knownSources: [],
      protocolVersion: 1,
    })
    expect(graph.suites[0]).not.toHaveProperty('name')
    const plan = await planMaestro({
      ...where(root),
      changes: ['app/build/app.apk'],
      currentEnvironmentFingerprint: 'env',
      graph,
    })
    expect(plan.mode).toBe('full')
  })

  test('editing a flow name changes the catalog fingerprint', async () => {
    const root = await project({ 'e2e/a.yaml': flow('A') })
    const before = maestroCatalogFingerprint(
      await discoverMaestroSuites(where(root)),
    )
    await writeFile(join(root, 'e2e/a.yaml'), flow('Renamed'))
    expect(
      maestroCatalogFingerprint(await discoverMaestroSuites(where(root))),
    ).not.toBe(before)
  })
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

describe('Maestro runner', () => {
  test('stores the graph under .tia/maestro and promotes it when nothing was selected', async () => {
    const root = await project({ 'e2e/a.yaml': flow('A') })
    const first = await runner(root).run()
    expect(first.plan.mode).toBe('full')
    const graphPath = join(root, '.tia/maestro/graph.json')
    expect(existsSync(graphPath)).toBe(true)
    await rm(graphPath)
    await mkdir(dirname(graphPath), { recursive: true })
    await writeFile(
      graphPath,
      JSON.stringify(
        createMaestroGraph({
          environmentFingerprint: 'env',
          suites: await discoverMaestroSuites(where(root)),
        }),
      ),
    )
    await rm(join(root, 'executions.log'))
    const skipped = await runner(root).run()
    expect(skipped.plan.mode).toBe('skip')
    expect(skipped.executions).toEqual([])
    expect(JSON.parse(await readFile(graphPath, 'utf8')).complete).toBe(true)
  })

  test('the promoted graph covers only the tag-filtered flows', async () => {
    const root = await project({
      'e2e/a.yaml': 'tags: [keep]\n---\n- launchApp\n',
      'e2e/b.yaml': 'tags: [drop]\n---\n- launchApp\n',
    })
    await runner(root, { excludeTags: ['drop'] }).run()
    const graph = JSON.parse(
      await readFile(join(root, '.tia/maestro/graph.json'), 'utf8'),
    )
    expect(graph.suites.map((suite: { file: string }) => suite.file)).toEqual([
      'e2e/a.yaml',
    ])
  })

  test('runs flows one at a time because they share the device lock', async () => {
    const root = await project({
      'e2e/a.yaml': flow('A'),
      'e2e/b.yaml': flow('B'),
      'e2e/c.yaml': flow('C'),
    })
    const result = await runner(root, { maxConcurrency: 3 }).run()
    expect(result.executions.map((item) => item.suiteId)).toEqual([
      'maestro:p:e2e/a.yaml',
      'maestro:p:e2e/b.yaml',
      'maestro:p:e2e/c.yaml',
    ])
    expect(
      (await readFile(join(root, 'executions.log'), 'utf8')).trim().split('\n'),
    ).toEqual(['e2e/a.yaml', 'e2e/b.yaml', 'e2e/c.yaml'])
  })

  test('discovery errors reject the run instead of returning a result', async () => {
    const root = await project({ 'e2e/bad.yaml': 'appId: [\n' })
    await expect(runner(root).run()).rejects.toThrow(/invalid Maestro flow/u)
  })
})
