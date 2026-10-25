import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaVerificationReceipt } from '../../../src/core/verification.ts'
import {
  packageRoot,
  runCommand,
  type CommandResult,
} from '../../support/runner-project.ts'

// `tiacore verify` over the suite-granular runners. Each project is a script
// that calls the built package's runner on a few files and a fake tool that
// stands in for k6, Maestro or Gradle. The environment tells the script which
// files changed (the runners take their change set from the caller) and which
// options to add.

const cli = join(packageRoot, 'dist/entries/cli.js')
const fakeGradle = join(
  packageRoot,
  'test/fixtures/gradle-project/fake-gradle.mjs',
)
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-suite-verify-'))
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const destination = join(root, 'node_modules', '@lucasacoutinho', 'tiacore')
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(packageRoot, destination)
  return root
}

// The tool the runners execute: log the file it was given, and fail for a
// file named by FIXTURE_FAIL, or by FIXTURE_FAIL_FULL in the full phase only.
const FAKE_TOOL = `
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
const file = process.argv.at(-1)
appendFileSync('executions.log', relative(process.cwd(), file) + '\\n')
const failing = [
  process.env.FIXTURE_FAIL,
  process.env.TIA_VERIFICATION_PHASE === 'full' ? process.env.FIXTURE_FAIL_FULL : undefined,
]
if (failing.some((name) => name && file.includes(name))) process.exitCode = 7
`

const SCRIPT_HEAD = `
const changes = JSON.parse(process.env.FIXTURE_CHANGES ?? '[]')
const extra = JSON.parse(process.env.FIXTURE_OPTIONS ?? '{}')
const tool = [new URL('./fake-tool.mjs', import.meta.url).pathname]
`

const K6_SCRIPT = `
import { tia } from '@lucasacoutinho/tiacore/k6'
${SCRIPT_HEAD}
const result = await tia({
  changes,
  command: process.execPath,
  commandArguments: tool,
  currentEnvironmentFingerprint: 'env',
  profiles: 'k6/profiles',
  project: 'p',
  root: process.cwd(),
  ...extra,
}).run()
process.exitCode = result.success ? 0 : 1
`

const MAESTRO_SCRIPT = `
import { tia } from '@lucasacoutinho/tiacore/maestro'
${SCRIPT_HEAD}
const result = await tia({
  changes,
  command: process.execPath,
  commandArguments: tool,
  currentEnvironmentFingerprint: 'env',
  flows: 'e2e',
  project: 'p',
  root: process.cwd(),
  ...extra,
}).run()
process.exitCode = result.success ? 0 : 1
`

const GRADLE_SCRIPT = `
import { tia } from '@lucasacoutinho/tiacore/gradle'
${SCRIPT_HEAD}
const result = await tia({
  changes,
  command: process.execPath,
  commandArguments: [${JSON.stringify(fakeGradle)}],
  currentEnvironmentFingerprint: 'env',
  project: 'app',
  root: process.cwd(),
  ...extra,
}).run()
process.exitCode = result.success ? 0 : 1
`

const K6_FILES = {
  'fake-tool.mjs': FAKE_TOOL,
  'k6/profiles/smoke.js': "import { member } from '../shared/member.js'\n",
  'k6/profiles/baseline.js': "import { http } from '../shared/http.js'\n",
  'k6/shared/http.js': 'export const http = 1\n',
  'k6/shared/member.js': 'export const member = 1\n',
  'run.mjs': K6_SCRIPT,
}

const MAESTRO_FILES = {
  'e2e/checkout.yaml': 'appId: app\n---\n- runFlow: login.yaml\n- launchApp\n',
  'e2e/home.yaml': 'appId: app\n---\n- launchApp\n',
  'e2e/login.yaml': 'appId: app\n---\n- launchApp\n',
  'fake-tool.mjs': FAKE_TOOL,
  'run.mjs': MAESTRO_SCRIPT,
}

function gradleProject(): string {
  const root = createProject({ 'run.mjs': GRADLE_SCRIPT })
  cpSync(
    join(packageRoot, 'test/fixtures/gradle-project/src'),
    join(root, 'src'),
    {
      recursive: true,
    },
  )
  return root
}

function run(
  root: string,
  args: string[],
  environment: Record<string, string> = {},
): CommandResult {
  return runCommand(root, process.execPath, args, 60_000, environment)
}

function baseline(root: string): void {
  const result = run(root, ['run.mjs'])
  expect(result.status, result.output).toBe(0)
  writeFileSync(join(root, 'executions.log'), '')
}

function verify(
  root: string,
  environment: Record<string, string>,
): { receipt: TiaVerificationReceipt; result: CommandResult } {
  const result = run(
    root,
    [
      cli,
      'verify',
      '--output',
      'verification.json',
      '--',
      process.execPath,
      'run.mjs',
    ],
    environment,
  )
  const receipt: TiaVerificationReceipt = JSON.parse(
    readFileSync(join(root, 'verification.json'), 'utf8'),
  )
  return { receipt, result }
}

function executed(root: string): string[] {
  const path = join(root, 'executions.log')
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).sort()
    : []
}

describe('tiacore verify over k6', () => {
  test('verifies a selective phase that ran the profiles a change reached', () => {
    const root = createProject(K6_FILES)
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify(['k6/shared/member.js']),
    })

    expect(result.status, result.output).toBe(0)
    expect(receipt.issues).toEqual([])
    expect(receipt).toMatchObject({
      accuracy: {
        executedTests: 1,
        expectedTests: 1,
        falseNegativeRate: 0,
        missedTests: 0,
        precision: 1,
        unnecessaryTests: 0,
      },
      performance: {
        executionReduction: 0.5,
        fallbacks: [],
        fullExecutedTests: 2,
        selectiveExecutedTests: 1,
        selectiveReplayedTests: 1,
      },
      success: true,
      verified: true,
    })
    expect(receipt.runners).toEqual([
      expect.objectContaining({
        runner: 'k6:.tia/k6/graph.json',
        selection: expect.objectContaining({
          executedTestIds: ['k6:p:k6/profiles/smoke.js'],
          expectedTestIds: ['k6:p:k6/profiles/smoke.js'],
          missedTestIds: [],
        }),
        unit: 'suite',
        verified: true,
      }),
    ])
    expect(receipt.phases.selective.runners).toEqual(['k6:.tia/k6/graph.json'])
    expect(executed(root)).toEqual([
      'k6/profiles/baseline.js',
      'k6/profiles/smoke.js',
      'k6/profiles/smoke.js',
    ])
  })

  test('fails when the selective phase skips a profile the change reached', () => {
    const root = createProject(K6_FILES)
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify(['k6/shared/member.js']),
      FIXTURE_OPTIONS: JSON.stringify({ ignoreChanges: ['k6/shared/**'] }),
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt).toMatchObject({ success: false, verified: false })
    expect(receipt.issues).toEqual([
      {
        code: 'selection-miss',
        message:
          'selective phase missed 1 required test: k6:p:k6/profiles/smoke.js',
        runner: 'k6:.tia/k6/graph.json',
      },
    ])
    expect(receipt.accuracy).toMatchObject({
      expectedTests: 1,
      falseNegativeRate: 1,
      missedTests: 1,
    })
    expect(executed(root)).toEqual([
      'k6/profiles/baseline.js',
      'k6/profiles/smoke.js',
    ])
  })

  test('fails when a profile the selective phase left alone fails in the full phase', () => {
    const root = createProject(K6_FILES)
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify(['k6/shared/member.js']),
      FIXTURE_FAIL_FULL: 'baseline.js',
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt.verified).toBe(false)
    expect(receipt.issues.map((issue) => issue.code).sort()).toEqual([
      'full-run-failed',
      'outcome-mismatch',
    ])
  })

  test('matching failures verify without turning the run green', () => {
    const root = createProject(K6_FILES)
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify(['k6/shared/member.js']),
      FIXTURE_FAIL: 'smoke.js',
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt).toMatchObject({ success: false, verified: true })
    expect(receipt.issues.map((issue) => issue.code)).toEqual([
      'selective-run-failed',
      'full-run-failed',
    ])
  })

  test('a first run with no graph is a recorded fallback that still verifies', () => {
    const root = createProject(K6_FILES)

    const { receipt, result } = verify(root, {})

    expect(result.status, result.output).toBe(0)
    expect(receipt.verified).toBe(true)
    expect(receipt.performance.fallbacks).toEqual([
      {
        reason: 'no compatible impact graph found',
        runner: 'k6:.tia/k6/graph.json',
      },
    ])
    expect(receipt.performance.executionReduction).toBe(0)
  })
})

describe('tiacore verify over Maestro', () => {
  test('verifies a selective phase that ran the flows a change reached', () => {
    const root = createProject(MAESTRO_FILES)
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify(['e2e/login.yaml']),
    })

    expect(result.status, result.output).toBe(0)
    expect(receipt.issues).toEqual([])
    expect(receipt.verified).toBe(true)
    expect(receipt.runners).toEqual([
      expect.objectContaining({
        runner: 'maestro:.tia/maestro/graph.json',
        selection: expect.objectContaining({
          executedTestIds: [
            'maestro:p:e2e/checkout.yaml',
            'maestro:p:e2e/login.yaml',
          ],
          expectedTestIds: [
            'maestro:p:e2e/checkout.yaml',
            'maestro:p:e2e/login.yaml',
          ],
        }),
        unit: 'suite',
      }),
    ])
    expect(receipt.performance).toMatchObject({
      fullExecutedTests: 3,
      selectiveExecutedTests: 2,
    })
  })

  test('fails when the selective phase skips a flow that runs the changed flow', () => {
    const root = createProject(MAESTRO_FILES)
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify(['e2e/login.yaml']),
      FIXTURE_OPTIONS: JSON.stringify({ ignoreChanges: ['e2e/login.yaml'] }),
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt.verified).toBe(false)
    expect(receipt.issues).toEqual([
      {
        code: 'selection-miss',
        message:
          'selective phase missed 2 required tests: maestro:p:e2e/checkout.yaml, maestro:p:e2e/login.yaml',
        runner: 'maestro:.tia/maestro/graph.json',
      },
    ])
  })
})

describe('tiacore verify over Gradle', () => {
  test('verifies a selective phase that ran the classes a change reached', () => {
    const root = gradleProject()
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify([
        'src/main/java/com/example/MathSupport.java',
      ]),
    })

    expect(result.status, result.output).toBe(0)
    expect(receipt.issues).toEqual([])
    expect(receipt.verified).toBe(true)
    expect(receipt.runners).toEqual([
      expect.objectContaining({
        runner: 'gradle:.tia/gradle/graph.json',
        selection: expect.objectContaining({
          executedTestIds: [
            'gradle-junit:app:src/test/java/com/example/CalculatorTest.java',
          ],
          missedTestIds: [],
        }),
        unit: 'suite',
      }),
    ])
    expect(receipt.performance).toMatchObject({
      fullExecutedTests: 2,
      selectiveExecutedTests: 1,
    })
  })

  test('fails when the selective phase skips a class the change reached', () => {
    const root = gradleProject()
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_CHANGES: JSON.stringify([
        'src/main/java/com/example/MathSupport.java',
      ]),
      FIXTURE_OPTIONS: JSON.stringify({ ignoreChanges: ['src/main/**'] }),
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt.verified).toBe(false)
    expect(receipt.issues).toEqual([
      {
        code: 'selection-miss',
        message:
          'selective phase missed 1 required test: gradle-junit:app:src/test/java/com/example/CalculatorTest.java',
        runner: 'gradle:.tia/gradle/graph.json',
      },
    ])
  })

  test('a selective phase that selected nothing still leaves a snapshot to verify', () => {
    const root = gradleProject()
    baseline(root)

    const { receipt, result } = verify(root, {})

    expect(result.status, result.output).toBe(0)
    expect(receipt.verified).toBe(true)
    expect(receipt.performance).toMatchObject({
      fullExecutedTests: 2,
      selectiveExecutedTests: 0,
    })
  })
})

describe('tiacore verify over several suite runners', () => {
  test('one command can run a k6 lane and a Maestro lane', () => {
    const root = createProject({
      ...K6_FILES,
      ...MAESTRO_FILES,
      'run-k6.mjs': K6_SCRIPT.replace('FIXTURE_CHANGES', 'FIXTURE_K6_CHANGES'),
      'run-maestro.mjs': MAESTRO_SCRIPT.replace(
        'FIXTURE_CHANGES',
        'FIXTURE_MAESTRO_CHANGES',
      ),
      'run.mjs': `
import { spawnSync } from 'node:child_process'
let status = 0
for (const script of ['run-k6.mjs', 'run-maestro.mjs']) {
  status ||= spawnSync(process.execPath, [script], { stdio: 'inherit' }).status ?? 1
}
process.exitCode = status
`,
    })
    baseline(root)

    const { receipt, result } = verify(root, {
      FIXTURE_K6_CHANGES: JSON.stringify(['k6/shared/member.js']),
      FIXTURE_MAESTRO_CHANGES: JSON.stringify(['e2e/home.yaml']),
    })

    expect(result.status, result.output).toBe(0)
    expect(receipt.issues).toEqual([])
    expect(
      receipt.runners.map((runner) => [runner.runner, runner.verified]),
    ).toEqual([
      ['k6:.tia/k6/graph.json', true],
      ['maestro:.tia/maestro/graph.json', true],
    ])
    expect(receipt.accuracy).toMatchObject({ executedTests: 2, missedTests: 0 })
  })
})
