import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaVerificationReceipt } from '../../../src/core/verification.ts'
import {
  packageRoot,
  runCommand,
  type CommandResult,
} from '../../support/runner-project.ts'

// `tiacore verify` over the Python and Go SDKs, which are separate programs
// that write the suite-granular snapshot themselves. The Python SDK takes its
// change set from the caller, so its script reads it from the environment; the
// Go SDK finds changes by comparing the project with its stored baseline.

const cli = join(packageRoot, 'dist/entries/cli.js')
const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tiacore-sdk-verify-'))
  temporary.push(directory)
  return directory
}

function verify(
  cwd: string,
  command: string[],
  environment: Record<string, string> = {},
): { receipt: TiaVerificationReceipt; result: CommandResult } {
  const result = runCommand(
    cwd,
    process.execPath,
    [cli, 'verify', '--output', 'verification.json', '--', ...command],
    120_000,
    environment,
  )
  const receipt: TiaVerificationReceipt = JSON.parse(
    readFileSync(join(cwd, 'verification.json'), 'utf8'),
  )
  return { receipt, result }
}

// The SDK's source digest covers every file under sdks/python/src, so running
// it must not leave bytecode there.
const PYTHON_ENVIRONMENT = { PYTHONDONTWRITEBYTECODE: '1' }

const PYTHON_SCRIPT = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(join(packageRoot, 'sdks/python/src'))})
from tiacore import TiaPytestOptions, tia

result = tia(TiaPytestOptions(
    root=".",
    changes=tuple(json.loads(os.environ.get("FIXTURE_CHANGES", "[]"))),
    ignore_changes=tuple(json.loads(os.environ.get("FIXTURE_IGNORE", "[]"))),
    environment_fingerprint="python-fixture",
    command=(sys.executable, "fake_pytest.py"),
    command_arguments=(),
    environment={"TIACORE_PYTEST_FIXTURE_LOG": "executions.log"},
)).run()
sys.exit(result.status)
`

function pythonProject(): string {
  const root = scratch()
  cpSync(join(packageRoot, 'sdks/python/tests/fixtures/project'), root, {
    recursive: true,
  })
  writeFileSync(join(root, 'run.py'), PYTHON_SCRIPT)
  const baseline = runCommand(
    root,
    'python3',
    ['run.py'],
    30_000,
    PYTHON_ENVIRONMENT,
  )
  expect(baseline.status, baseline.output).toBe(0)
  writeFileSync(join(root, 'executions.log'), '')
  return root
}

function executed(root: string): string[] {
  const path = join(root, 'executions.log')
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).sort()
    : []
}

describe('tiacore verify over the Python SDK', () => {
  test('verifies a selective phase that ran the files a change reached', () => {
    const root = pythonProject()

    const { receipt, result } = verify(root, ['python3', 'run.py'], {
      ...PYTHON_ENVIRONMENT,
      FIXTURE_CHANGES: JSON.stringify(['src/example/a.py']),
    })

    expect(result.status, result.output).toBe(0)
    expect(receipt.issues).toEqual([])
    expect(receipt.verified).toBe(true)
    expect(receipt.runners).toEqual([
      expect.objectContaining({
        runner: 'pytest:.tia/pytest/graph.json',
        selection: expect.objectContaining({
          executedTestIds: ['pytest:pytest:tests/test_a.py'],
          expectedTestIds: ['pytest:pytest:tests/test_a.py'],
          missedTestIds: [],
        }),
        unit: 'suite',
        verified: true,
      }),
    ])
    expect(receipt.performance).toMatchObject({
      fullExecutedTests: 2,
      selectiveExecutedTests: 1,
    })
    expect(executed(root)).toEqual([
      'tests/test_a.py',
      'tests/test_a.py',
      'tests/test_b.py',
    ])
  })

  test('fails when the selective phase skips a file the change reached', () => {
    const root = pythonProject()

    const { receipt, result } = verify(root, ['python3', 'run.py'], {
      ...PYTHON_ENVIRONMENT,
      FIXTURE_CHANGES: JSON.stringify(['src/example/a.py']),
      FIXTURE_IGNORE: JSON.stringify(['src/**']),
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt.verified).toBe(false)
    expect(receipt.issues).toEqual([
      {
        code: 'selection-miss',
        message:
          'selective phase missed 1 required test: pytest:pytest:tests/test_a.py',
        runner: 'pytest:.tia/pytest/graph.json',
      },
    ])
  })

  test('attributes a failure to the file that holds it', () => {
    const root = pythonProject()

    const { receipt, result } = verify(root, ['python3', 'run.py'], {
      ...PYTHON_ENVIRONMENT,
      FIXTURE_CHANGES: JSON.stringify(['src/example/a.py']),
      TIACORE_PYTEST_FIXTURE_EXIT: '1',
      TIACORE_PYTEST_FIXTURE_OUTCOMES: JSON.stringify([
        ['tests.test_a', 'test_a', 'failed'],
        ['tests.test_b', 'test_b', 'passed'],
      ]),
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt).toMatchObject({ success: false, verified: true })
    expect(receipt.issues.map((issue) => issue.code)).toEqual([
      'selective-run-failed',
      'full-run-failed',
    ])
  })

  test('does not verify a failure it cannot attribute to a file', () => {
    const root = pythonProject()

    const { receipt, result } = verify(root, ['python3', 'run.py'], {
      ...PYTHON_ENVIRONMENT,
      FIXTURE_CHANGES: JSON.stringify(['src/example/a.py']),
      TIACORE_PYTEST_FIXTURE_EXIT: '1',
    })

    expect(result.status, result.output).toBe(1)
    expect(receipt.verified).toBe(false)
    expect(receipt.issues.map((issue) => issue.code)).toContain(
      'outcome-mismatch',
    )
  })
})

const GO_AVAILABLE = spawnSync('go', ['version']).status === 0

function goProject(): { binary: string; root: string } {
  const directory = scratch()
  const binary = join(directory, 'tiacore-go')
  const build = spawnSync('go', ['build', '-o', binary, './cmd/tiacore-go'], {
    cwd: join(packageRoot, 'sdks/go'),
    encoding: 'utf8',
  })
  expect(build.status, `${build.stdout}${build.stderr}`).toBe(0)
  const root = join(directory, 'project')
  cpSync(join(packageRoot, 'sdks/go/testdata/project'), root, {
    recursive: true,
  })
  const baseline = runCommand(root, binary, ['--root', root])
  expect(baseline.status, baseline.output).toBe(0)
  return { binary, root }
}

describe.skipIf(!GO_AVAILABLE)('tiacore verify over the Go SDK', () => {
  test('verifies a selective phase that ran the packages a change reached', () => {
    const { binary, root } = goProject()
    writeFileSync(
      join(root, 'lib/a/a.go'),
      `${readFileSync(join(root, 'lib/a/a.go'), 'utf8')}\n// changed\n`,
    )

    const { receipt, result } = verify(root, [binary, '--root', root])

    expect(result.status, result.output).toBe(0)
    expect(receipt.issues).toEqual([])
    expect(receipt.verified).toBe(true)
    expect(receipt.runners).toEqual([
      expect.objectContaining({
        runner: 'go-test:.tia/go/state.json',
        unit: 'suite',
        verified: true,
      }),
    ])
    expect(receipt.accuracy).toMatchObject({ missedTests: 0 })
    expect(receipt.performance.selectiveExecutedTests).toBeLessThan(
      receipt.performance.fullExecutedTests,
    )
  })

  test('fails when a stale baseline graph lets the selective phase skip a package', () => {
    const { binary, root } = goProject()
    // The baseline forgot that app/a imports lib/a. lib/a stays known through
    // its own package, so the change is not an unknown file and selects only
    // lib/a, although the fresh graph of the same run shows app/a needs it.
    const statePath = join(root, '.tia/go/state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.graph.observations = state.graph.observations.filter(
      (item: { source: string; suiteId: string }) =>
        !(
          item.suiteId === 'go-package:example.com/fixture/app/a' &&
          item.source === 'lib/a/a.go'
        ),
    )
    writeFileSync(statePath, JSON.stringify(state, null, 2))
    writeFileSync(
      join(root, 'lib/a/a.go'),
      `${readFileSync(join(root, 'lib/a/a.go'), 'utf8')}\n// changed\n`,
    )

    const { receipt, result } = verify(root, [binary, '--root', root])

    expect(result.status, result.output).toBe(1)
    expect(receipt.verified).toBe(false)
    expect(receipt.issues).toEqual([
      {
        code: 'selection-miss',
        message:
          'selective phase missed 1 required test: go-package:example.com/fixture/app/a',
        runner: 'go-test:.tia/go/state.json',
      },
    ])
  })

  test('verifies matching failures once go test has named the failing package', () => {
    const { binary, root } = goProject()
    writeFileSync(
      join(root, 'app/a/a.go'),
      readFileSync(join(root, 'app/a/a.go'), 'utf8').replace(
        'library.Value()',
        'library.Value() + "x"',
      ),
    )

    const { receipt, result } = verify(root, [binary, '--root', root])

    expect(result.status, result.output).toBe(1)
    expect(receipt).toMatchObject({ success: false, verified: true })
    expect(receipt.issues.map((issue) => issue.code)).toEqual([
      'selective-run-failed',
      'full-run-failed',
    ])
  })
})
