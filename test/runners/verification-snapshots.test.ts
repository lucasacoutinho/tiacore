import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { readSnapshot } from '../../src/assurance/verify/snapshot-read.ts'
import type {
  TiaProtocolVerificationSnapshot,
  TiaVerificationPhase,
} from '../../src/core/verification.ts'
import { tia as gradle } from '../../src/runners/gradle/index.ts'
import { tia as k6 } from '../../src/runners/k6/index.ts'
import { tia as maestro } from '../../src/runners/maestro/index.ts'
import { assertNoLeak } from '../support/leak.ts'

const gradleFixture = fileURLToPath(
  new URL('../fixtures/gradle-project', import.meta.url),
)
const fakeGradle = join(gradleFixture, 'fake-gradle.mjs')
const fakeRunner = fileURLToPath(
  new URL('../fixtures/fake-adapter-runner.mjs', import.meta.url),
)
const temporary: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `tiacore-${prefix}-`))
  temporary.push(directory)
  return directory
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratch('snapshots')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

function verifying(directory: string, phase: TiaVerificationPhase): void {
  vi.stubEnv('TIA_VERIFICATION_DIRECTORY', directory)
  vi.stubEnv('TIA_VERIFICATION_PHASE', phase)
}

/** The one snapshot a phase wrote, read like the verifier reads it. */
async function snapshotOf(
  directory: string,
  phase: TiaVerificationPhase,
): Promise<TiaProtocolVerificationSnapshot> {
  const names = await readdir(join(directory, phase))
  expect(names).toHaveLength(1)
  const value: unknown = JSON.parse(
    await readFile(join(directory, phase, names[0] ?? ''), 'utf8'),
  )
  const snapshot = readSnapshot(value, phase)
  if (snapshot === null || snapshot.kind !== 'protocol') {
    throw new Error('expected a valid protocol snapshot')
  }
  return snapshot
}

const k6Profiles = {
  'k6/profiles/a.js': "import { x } from '../shared/x.js'\n",
  'k6/profiles/b.js': '',
  'k6/shared/x.js': 'export const x = 1\n',
}

function k6Runner(root: string, extra: Record<string, unknown> = {}) {
  return k6({
    changes: [],
    command: process.execPath,
    commandArguments: [fakeRunner],
    currentEnvironmentFingerprint: 'env',
    environment: { TIACORE_FAKE_RUNNER_LOG: join(root, 'executions.log') },
    profiles: 'k6/profiles',
    project: 'p',
    root,
    ...extra,
  })
}

describe('TIA_FRESH in the suite runners', () => {
  test('k6 plans every profile', async () => {
    const root = await project(k6Profiles)
    await k6Runner(root).run()
    expect((await k6Runner(root).run()).plan.mode).toBe('skip')
    vi.stubEnv('TIA_FRESH', '1')
    const fresh = await k6Runner(root).run()
    expect(fresh.plan).toMatchObject({
      mode: 'full',
      reason: 'policy requires a full run',
    })
    expect(fresh.executions).toHaveLength(2)
  })

  test('Maestro plans every flow, with the words TIA_FRESH accepts', async () => {
    const root = await project({
      'e2e/a.yaml': 'appId: app\n---\n- launchApp\n',
      'e2e/b.yaml': 'appId: app\n---\n- launchApp\n',
    })
    const runner = () =>
      maestro({
        changes: [],
        command: process.execPath,
        commandArguments: [fakeRunner],
        currentEnvironmentFingerprint: 'env',
        environment: { TIACORE_FAKE_RUNNER_LOG: join(root, 'executions.log') },
        flows: 'e2e',
        project: 'p',
        root,
      })
    await runner().run()
    expect((await runner().run()).plan.mode).toBe('skip')
    vi.stubEnv('TIA_FRESH', 'Yes')
    expect((await runner().run()).plan.mode).toBe('full')
  })

  test('Gradle plans every class', async () => {
    const root = await gradleProject()
    await gradleRunner(root).run()
    expect((await gradleRunner(root).run()).plan.mode).toBe('skip')
    vi.stubEnv('TIA_FRESH', 'true')
    const fresh = await gradleRunner(root).run()
    expect(fresh.plan.mode).toBe('full')
    expect(fresh.plan.selected).toHaveLength(2)
  })

  test('a value that is not a yes leaves the plan alone', async () => {
    const root = await project(k6Profiles)
    await k6Runner(root).run()
    vi.stubEnv('TIA_FRESH', '0')
    expect((await k6Runner(root).run()).plan.mode).toBe('skip')
  })
})

async function gradleProject(): Promise<string> {
  const directory = await scratch('gradle-snapshots')
  const root = join(directory, 'project')
  await cp(gradleFixture, root, {
    filter: (source) => !source.includes(`${sep}build`),
    recursive: true,
  })
  return root
}

function gradleRunner(root: string, extra: Record<string, unknown> = {}) {
  return gradle({
    changes: [],
    command: process.execPath,
    commandArguments: [fakeGradle],
    currentEnvironmentFingerprint: 'env',
    project: 'app',
    root,
    ...extra,
  })
}

describe('a suite runner under tiacore verify', () => {
  test('writes nothing without a verification target', async () => {
    const root = await project(k6Profiles)
    await k6Runner(root).run()
    expect(existsSync(join(root, 'selective'))).toBe(false)
    expect((await readdir(root)).sort()).toEqual([
      '.tia',
      'executions.log',
      'k6',
    ])
  })

  test('k6 records its plan, the suites that ran, their outcomes and its graph', async () => {
    const root = await project(k6Profiles)
    const directory = await scratch('target')
    await k6Runner(root).run()
    verifying(directory, 'selective')
    const result = await k6Runner(root, { changes: ['k6/shared/x.js'] }).run()

    const snapshot = await snapshotOf(directory, 'selective')
    expect(snapshot).toMatchObject({
      executedTestIds: ['k6:p:k6/profiles/a.js'],
      kind: 'protocol',
      phase: 'selective',
      plan: result.plan,
      runner: 'k6:.tia/k6/graph.json',
      schema: 1,
      success: true,
      suiteOutcomes: { 'k6:p:k6/profiles/a.js': 'passed' },
    })
    expect(snapshot.plan.mode).toBe('selective')
    expect(snapshot.graph.complete).toBe(true)
    expect(snapshot.graph.observations.map((item) => item.source)).toContain(
      'k6/shared/x.js',
    )
    const [name] = await readdir(join(directory, 'selective'))
    expect(name).toBe(
      `${createHash('sha256')
        .update('k6:.tia/k6/graph.json')
        .update('\0')
        .update(snapshot.graph.fingerprint)
        .digest('hex')}.json`,
    )
  })

  test('a failed run still records the graph it would have promoted, with the failure', async () => {
    const root = await project(k6Profiles)
    const directory = await scratch('target')
    verifying(directory, 'full')
    const result = await k6Runner(root, {
      environment: {
        TIACORE_FAKE_RUNNER_FAIL: 'a.js',
        TIACORE_FAKE_RUNNER_LOG: join(root, 'executions.log'),
      },
    }).run()
    expect(result.success).toBe(false)
    expect(existsSync(join(root, '.tia/k6/graph.json'))).toBe(false)

    const snapshot = await snapshotOf(directory, 'full')
    expect(snapshot).toMatchObject({
      executedTestIds: ['k6:p:k6/profiles/a.js', 'k6:p:k6/profiles/b.js'],
      success: false,
      suiteOutcomes: {
        'k6:p:k6/profiles/a.js': 'failed',
        'k6:p:k6/profiles/b.js': 'passed',
      },
    })
    expect(snapshot.graph.suites).toHaveLength(2)
  })

  test('a skipped run records that nothing ran', async () => {
    const root = await project(k6Profiles)
    const directory = await scratch('target')
    await k6Runner(root).run()
    verifying(directory, 'selective')
    await k6Runner(root).run()
    expect(await snapshotOf(directory, 'selective')).toMatchObject({
      executedTestIds: [],
      plan: { cached: expect.any(Array), mode: 'skip', selected: [] },
      suiteOutcomes: {},
    })
  })

  test('lanes keep their snapshots apart by their graph file', async () => {
    const root = await project(k6Profiles)
    const directory = await scratch('target')
    verifying(directory, 'full')
    await k6Runner(root).run()
    await k6Runner(root, { graphPath: '.tia/lane/graph.json' }).run()
    expect(await readdir(join(directory, 'full'))).toHaveLength(2)
  })

  test('Maestro records the flows that ran', async () => {
    const root = await project({
      'e2e/a.yaml': 'appId: app\n---\n- launchApp\n',
    })
    const directory = await scratch('target')
    verifying(directory, 'full')
    await maestro({
      changes: [],
      command: process.execPath,
      commandArguments: [fakeRunner],
      currentEnvironmentFingerprint: 'env',
      environment: { TIACORE_FAKE_RUNNER_LOG: join(root, 'executions.log') },
      flows: 'e2e',
      project: 'p',
      root,
    }).run()
    expect(await snapshotOf(directory, 'full')).toMatchObject({
      executedTestIds: ['maestro:p:e2e/a.yaml'],
      runner: 'maestro:.tia/maestro/graph.json',
      success: true,
      suiteOutcomes: { 'maestro:p:e2e/a.yaml': 'passed' },
    })
  })

  test('Gradle attributes each class to its JUnit cases', async () => {
    const root = await gradleProject()
    const directory = await scratch('target')
    verifying(directory, 'full')
    const result = await gradleRunner(root).run()
    expect(result.success).toBe(true)
    const snapshot = await snapshotOf(directory, 'full')
    expect(snapshot.runner).toBe('gradle:.tia/gradle/graph.json')
    expect(snapshot.executedTestIds).toHaveLength(2)
    expect(Object.values(snapshot.suiteOutcomes)).toEqual(['passed', 'passed'])
    expect(snapshot.success).toBe(true)
  })

  test('Gradle reports a failing class even though the run promotes nothing', async () => {
    const root = await gradleProject()
    const directory = await scratch('target')
    verifying(directory, 'full')
    const result = await gradleRunner(root, {
      environment: { TIACORE_GRADLE_TEST_FAILURE: '1' },
    }).run()
    expect(result.success).toBe(false)
    expect(existsSync(join(root, '.tia/gradle/graph.json'))).toBe(false)
    const snapshot = await snapshotOf(directory, 'full')
    expect(Object.values(snapshot.suiteOutcomes)).toEqual(['failed', 'failed'])
    expect(snapshot.success).toBe(false)
  })

  test('Gradle cannot attribute a class that reported nothing', async () => {
    const root = await gradleProject()
    const directory = await scratch('target')
    verifying(directory, 'full')
    await gradleRunner(root, {
      environment: { TIACORE_GRADLE_PROCESS_FAILURE: '1' },
    }).run()
    const snapshot = await snapshotOf(directory, 'full')
    expect(Object.values(snapshot.suiteOutcomes)).toEqual([
      'unknown',
      'unknown',
    ])
    expect(snapshot.success).toBe(false)
  })

  test('Gradle records a selective phase that selected nothing', async () => {
    const root = await gradleProject()
    const directory = await scratch('target')
    await gradleRunner(root).run()
    verifying(directory, 'selective')
    await gradleRunner(root).run()
    expect(await snapshotOf(directory, 'selective')).toMatchObject({
      executedTestIds: [],
      plan: { mode: 'skip' },
      success: true,
    })
  })

  test('a half-set target fails before anything runs', async () => {
    const root = await project(k6Profiles)
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', await scratch('target'))
    await expect(k6Runner(root).run()).rejects.toThrow(
      'TIA_VERIFICATION_DIRECTORY and TIA_VERIFICATION_PHASE must be set together',
    )
    expect(existsSync(join(root, 'executions.log'))).toBe(false)
    expect(existsSync(join(root, '.tia'))).toBe(false)
  })

  test('an unknown phase fails before anything runs', async () => {
    const root = await gradleProject()
    vi.stubEnv('TIA_VERIFICATION_DIRECTORY', await scratch('target'))
    vi.stubEnv('TIA_VERIFICATION_PHASE', 'both')
    await expect(gradleRunner(root).run()).rejects.toThrow(
      'TIA_VERIFICATION_PHASE must be selective or full',
    )
    expect(existsSync(join(root, '.tia'))).toBe(false)
  })

  test('does not leak across repeated verified runs', async () => {
    const root = await project({ 'k6/profiles/a.js': '' })
    verifying(await scratch('target'), 'full')
    const { bytesPerOperation } = await assertNoLeak(
      () => k6Runner(root, { forceFull: true }).run(),
      { bytesPerOperation: 20_000, iterations: 10 },
    )
    expect(bytesPerOperation).toBeLessThan(20_000)
  }, 60_000)
})
