import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import {
  createK6Graph,
  discoverK6Suites,
  planK6,
} from '../src/adapters/k6.js'

const root = fileURLToPath(new URL('fixtures/k6-project', import.meta.url))

describe('k6 adapter', () => {
  test('discovers real profile entrypoints', async () => {
    const suites = await discoverK6Suites({
      profiles: 'k6/profiles',
      project: 'fixture',
      root,
    })

    expect(suites.map((suite) => suite.profile)).toEqual([
      'baseline',
      'smoke',
    ])
    expect(suites.every((suite) => suite.resourceLocks?.includes('performance-host'))).toBe(
      true,
    )
  })

  test('links shared imports to every profile that uses them', async () => {
    const suites = await discoverK6Suites({
      profiles: 'k6/profiles',
      project: 'fixture',
      root,
    })
    const graph = await createK6Graph(root, {
      environmentFingerprint: 'k6-container',
      suites,
    })
    const plan = await planK6({
      changes: ['k6/shared/http.js'],
      currentEnvironmentFingerprint: 'k6-container',
      graph,
      profiles: 'k6/profiles',
      project: 'fixture',
      root,
    })

    expect(plan.mode).toBe('selective')
    expect(plan.selected).toEqual([
      'k6:fixture:k6/profiles/baseline.js',
      'k6:fixture:k6/profiles/smoke.js',
    ])
    expect(plan.resourceLocks).toEqual(['performance-host'])
  })

  test('never authorizes a profile outside the requested lane', async () => {
    const suites = await discoverK6Suites({
      profiles: 'k6/profiles',
      project: 'fixture',
      root,
    })
    const graph = await createK6Graph(root, {
      environmentFingerprint: 'k6-container',
      suites,
    })
    const plan = await planK6({
      allowedProfiles: ['smoke'],
      changes: ['k6/shared/member.js'],
      currentEnvironmentFingerprint: 'k6-container',
      graph,
      profiles: 'k6/profiles',
      project: 'fixture',
      root,
    })

    expect(plan).toMatchObject({
      cached: ['k6:fixture:k6/profiles/smoke.js'],
      mode: 'skip',
      selected: [],
    })
  })
})
