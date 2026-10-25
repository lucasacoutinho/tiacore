import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createMaestroGraph,
  discoverMaestroSuites,
  maestroCatalogFingerprint,
  planMaestro,
  tia,
} from '../../src/runners/maestro/index.ts'

const root = fileURLToPath(
  new URL('../fixtures/maestro-project', import.meta.url),
)
const fakeRunner = fileURLToPath(
  new URL('../fixtures/fake-adapter-runner.mjs', import.meta.url),
)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('Maestro adapter', () => {
  test('discovers real flow files, tags, and runFlow dependencies', async () => {
    const suites = await discoverMaestroSuites({
      excludeTags: ['experimental'],
      flows: 'e2e',
      project: 'fixture',
      root,
    })

    expect(suites.map((suite) => suite.file)).toEqual([
      'e2e/login.yaml',
      'e2e/settings.yaml',
    ])
    expect(suites[1]).toMatchObject({
      dependsOn: ['maestro:fixture:e2e/login.yaml'],
      name: 'Open settings after sign in',
      resourceLocks: ['maestro-device'],
      tags: ['health', 'settings'],
    })
  })

  test('selects a changed included flow and its parent', async () => {
    const suites = await discoverMaestroSuites({
      flows: 'e2e',
      project: 'fixture',
      root,
    })
    const graph = createMaestroGraph({
      environmentFingerprint: 'android-35',
      suites,
    })
    const plan = await planMaestro({
      changes: ['e2e/login.yaml'],
      currentEnvironmentFingerprint: 'android-35',
      flows: 'e2e',
      graph,
      project: 'fixture',
      root,
    })

    expect(plan.mode).toBe('selective')
    expect(plan.selected).toEqual([
      'maestro:fixture:e2e/login.yaml',
      'maestro:fixture:e2e/settings.yaml',
    ])
  })

  test('uses a stable catalog fingerprint', async () => {
    const suites = await discoverMaestroSuites({
      flows: 'e2e',
      project: 'fixture',
      root,
    })

    expect(maestroCatalogFingerprint(suites)).toMatch(/^[a-f0-9]{64}$/u)
    expect(maestroCatalogFingerprint([...suites].reverse())).toBe(
      maestroCatalogFingerprint(suites),
    )
  })

  test('executes affected real flows through the Maestro command boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tiacore-maestro-runner-'))
    temporaryDirectories.push(directory)
    const log = join(directory, 'executions.log')
    const result = await tia({
      changes: ['e2e/login.yaml'],
      command: process.execPath,
      commandArguments: [fakeRunner],
      currentEnvironmentFingerprint: 'android-35',
      environment: { TIACORE_FAKE_RUNNER_LOG: log },
      flows: 'e2e',
      graph: createMaestroGraph({
        environmentFingerprint: 'android-35',
        suites: await discoverMaestroSuites({
          flows: 'e2e',
          project: 'fixture',
          root,
        }),
      }),
      graphPath: join(directory, 'graph.json'),
      maxConcurrency: 4,
      project: 'fixture',
      root,
    }).run()

    expect(result.success).toBe(true)
    expect(result.plan.mode).toBe('selective')
    expect(readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual([
      'e2e/login.yaml',
      'e2e/settings.yaml',
    ])
  })

  test('does not promote a graph when an affected flow fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tiacore-maestro-failure-'))
    temporaryDirectories.push(directory)
    const graphPath = join(directory, 'graph.json')
    const result = await tia({
      changes: ['e2e/login.yaml'],
      command: process.execPath,
      commandArguments: [fakeRunner],
      currentEnvironmentFingerprint: 'android-35',
      environment: {
        TIACORE_FAKE_RUNNER_FAIL: 'login.yaml',
        TIACORE_FAKE_RUNNER_LOG: join(directory, 'executions.log'),
      },
      flows: 'e2e',
      graph: createMaestroGraph({
        environmentFingerprint: 'android-35',
        suites: await discoverMaestroSuites({
          flows: 'e2e',
          project: 'fixture',
          root,
        }),
      }),
      graphPath,
      project: 'fixture',
      root,
    }).run()

    expect(result).toMatchObject({ status: 7, success: false })
    expect(existsSync(graphPath)).toBe(false)
  })
})
