import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import {
  createMaestroGraph,
  discoverMaestroSuites,
  maestroCatalogFingerprint,
  planMaestro,
} from '../src/adapters/maestro.js'

const root = fileURLToPath(new URL('fixtures/maestro-project', import.meta.url))

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
})
