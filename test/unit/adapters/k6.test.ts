import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createK6Graph,
  discoverK6Suites,
  planK6,
  tia,
} from '../../../src/adapters/k6/index.js'

const root = fileURLToPath(new URL('../../fixtures/k6-project', import.meta.url))
const fakeRunner = fileURLToPath(
  new URL('../../fixtures/fake-adapter-runner.mjs', import.meta.url),
)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

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

  test('executes the selected real profiles and promotes a reusable graph', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tiacore-k6-runner-'))
    temporaryDirectories.push(directory)
    const graphPath = join(directory, 'graph.json')
    const log = join(directory, 'executions.log')
    const options = {
      changes: [] as string[],
      command: process.execPath,
      commandArguments: [fakeRunner],
      currentEnvironmentFingerprint: 'k6-container',
      environment: { TIACORE_FAKE_RUNNER_LOG: log },
      graphPath,
      profiles: 'k6/profiles',
      project: 'fixture',
      root,
    }

    const baseline = await tia(options).run()
    expect(baseline.success).toBe(true)
    expect(baseline.plan.mode).toBe('full')
    expect(
      readFileSync(log, 'utf8').trim().split('\n').sort(),
    ).toEqual([
      'k6/profiles/baseline.js',
      'k6/profiles/smoke.js',
    ])
    expect(JSON.parse(await readFile(graphPath, 'utf8'))).toMatchObject({
      complete: true,
      protocolVersion: 1,
    })

    const skipped = await tia(options).run()
    expect(skipped.plan.mode).toBe('skip')
    expect(skipped.executions).toEqual([])
  })
})
