import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaImpactGraph } from '../../src/core/protocol.ts'
import {
  createMaestroGraph,
  discoverMaestroSuites,
  planMaestro,
  tia,
} from '../../src/runners/maestro/index.ts'

const fakeRunner = fileURLToPath(
  new URL('../fixtures/fake-adapter-runner.mjs', import.meta.url),
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
  const root = await mkdtemp(join(tmpdir(), 'tiacore-maestro-dependencies-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

const where = (root: string) => ({
  excludeTags: ['helper'],
  flows: 'e2e',
  project: 'p',
  root,
})

async function recordedGraph(root: string): Promise<TiaImpactGraph> {
  const result = await tia({
    changes: [],
    command: process.execPath,
    commandArguments: [fakeRunner],
    currentEnvironmentFingerprint: 'env',
    environment: { TIACORE_FAKE_RUNNER_LOG: join(root, 'executions.log') },
    ...where(root),
  }).run()
  expect(result.success).toBe(true)
  return JSON.parse(
    await readFile(join(root, '.tia/maestro/graph.json'), 'utf8'),
  ) as TiaImpactGraph
}

function edgesOf(graph: TiaImpactGraph, file: string): string[][] {
  return graph.observations
    .filter((observation) => observation.suiteId === `maestro:p:${file}`)
    .map(({ kind, source }) => [source, kind])
}

async function selected(
  root: string,
  graph: TiaImpactGraph,
  changes: string[],
): Promise<string[]> {
  const plan = await planMaestro({
    ...where(root),
    changes,
    currentEnvironmentFingerprint: 'env',
    graph,
  })
  return plan.selected
}

describe('Maestro flows behind an excluded helper', () => {
  test('a flow depends on the included flows it reaches through an excluded helper', async () => {
    const root = await project({
      'e2e/checkout.yaml':
        'appId: app\ntags: [smoke]\n---\n- runFlow: helpers/login.yaml\n',
      'e2e/helpers/login.yaml':
        'appId: app\ntags: [helper]\n---\n- runFlow: ../account.yaml\n',
      'e2e/account.yaml': 'appId: app\ntags: [smoke]\n---\n- launchApp\n',
    })
    const suites = await discoverMaestroSuites(where(root))
    expect(suites.map((suite) => [suite.file, suite.dependsOn])).toEqual([
      ['e2e/account.yaml', []],
      ['e2e/checkout.yaml', ['maestro:p:e2e/account.yaml']],
    ])
    const graph = createMaestroGraph({ environmentFingerprint: 'env', suites })
    expect(await selected(root, graph, ['e2e/account.yaml'])).toEqual([
      'maestro:p:e2e/account.yaml',
      'maestro:p:e2e/checkout.yaml',
    ])
  })
})

describe('Maestro files a flow uses', () => {
  test('the recorded graph links a flow to its excluded helpers, scripts and media', async () => {
    const root = await project({
      'e2e/checkout.yaml': [
        'appId: app',
        'tags: [smoke]',
        '---',
        '- runFlow: helpers/login.yaml',
        '- addMedia:',
        '    - assets/cat.png',
        '- addMedia:',
        '    files:',
        '      - assets/dog.png',
        '',
      ].join('\n'),
      'e2e/helpers/login.yaml': [
        'appId: app',
        'tags: [helper]',
        '---',
        '- runScript: ../scripts/seed.js',
        '- runScript:',
        '    file: ../../shared/env.js',
        '    env:',
        '      USER: a',
        '',
      ].join('\n'),
      'e2e/scripts/seed.js': 'output.seeded = true\n',
      'shared/env.js': 'output.env = 1\n',
      'e2e/assets/cat.png': 'png',
      'e2e/assets/dog.png': 'png',
      'e2e/other.yaml': 'appId: app\ntags: [smoke]\n---\n- launchApp\n',
    })
    const graph = await recordedGraph(root)
    expect(edgesOf(graph, 'e2e/checkout.yaml').sort()).toEqual([
      ['e2e/assets/cat.png', 'fixture'],
      ['e2e/assets/dog.png', 'fixture'],
      ['e2e/checkout.yaml', 'configuration'],
      ['e2e/helpers/login.yaml', 'fixture'],
      ['e2e/scripts/seed.js', 'fixture'],
      ['shared/env.js', 'fixture'],
    ])
    expect(edgesOf(graph, 'e2e/other.yaml')).toEqual([
      ['e2e/other.yaml', 'configuration'],
    ])
    for (const changed of [
      'e2e/helpers/login.yaml',
      'e2e/scripts/seed.js',
      'shared/env.js',
      'e2e/assets/dog.png',
    ]) {
      expect(await selected(root, graph, [changed])).toEqual([
        'maestro:p:e2e/checkout.yaml',
      ])
    }
  })

  test('a script named through a variable keeps every script change unknown', async () => {
    const root = await project({
      'e2e/a.yaml': 'appId: app\n---\n- runScript: scripts/seed.js\n',
      'e2e/b.yaml': 'appId: app\n---\n- runScript: ${DIR}/seed.js\n',
      'e2e/scripts/seed.js': 'output.seeded = true\n',
    })
    const graph = await recordedGraph(root)
    expect(edgesOf(graph, 'e2e/a.yaml')).toEqual([
      ['e2e/a.yaml', 'configuration'],
    ])
    expect(await selected(root, graph, ['e2e/scripts/seed.js'])).toEqual([
      'maestro:p:e2e/a.yaml',
      'maestro:p:e2e/b.yaml',
    ])
  })

  test('references that cannot be followed are skipped without failing the run', async () => {
    const root = await project({
      'e2e/a.yaml': [
        'appId: app',
        '---',
        '- runScript: ${SCRIPT}',
        '- runScript: ../../outside.js',
        '- addMedia:',
        '    - /nowhere/never.png',
        '- launchApp',
        '',
      ].join('\n'),
      'e2e/helper.yaml': 'tags: [helper]\n---\n- runFlow: ../../outside.yaml\n',
    })
    const graph = await recordedGraph(root)
    expect(
      graph.observations.map(({ kind, source }) => [source, kind]),
    ).toEqual([['e2e/a.yaml', 'configuration']])
  })
})
