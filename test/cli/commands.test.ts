import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

import { execute } from '../../src/cli/main.ts'
import { disposeHost } from '../../src/host/runtime.ts'

afterAll(disposeHost)

const directories: string[] = []
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-cli-commands-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { force: true, recursive: true })
})

function planInputs(root: string) {
  const catalog = join(root, 'catalog.json')
  const changes = join(root, 'changes.json')
  writeFileSync(
    catalog,
    JSON.stringify([
      {
        adapter: 'k6',
        file: 'profiles/smoke.js',
        id: 'k6:smoke',
        project: 'load',
      },
    ]),
  )
  writeFileSync(changes, JSON.stringify(['src/health.ts']))
  return [
    'plan',
    '--catalog',
    catalog,
    '--changes',
    changes,
    '--environment-fingerprint',
    'local',
    '--fingerprint',
    'project',
  ]
}

/** Runs the CLI with stdout and stderr captured. */
async function captured(argv: readonly string[]) {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const text = (spy: typeof stdout) =>
    spy.mock.calls.map(([chunk]) => String(chunk)).join('')
  try {
    const outcome = await execute(argv)
    return { outcome, stderr: text(stderr), stdout: text(stdout) }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

describe('a failure reported in a receipt', () => {
  const failingLane =
    "export default { lanes: [{ id: 'only', command: process.execPath, arguments: ['-e', 'process.exit(1)'] }] }"

  test('tiacore run names the receipt file on stderr', async () => {
    const root = scratch()
    const config = join(root, 'tiacore.config.mjs')
    const output = join(root, 'out', 'receipt.json')
    writeFileSync(config, failingLane)
    const result = await captured([
      'run',
      '--config',
      config,
      '--output',
      output,
    ])
    expect(result.outcome).toEqual({ code: 1, silent: true })
    expect(result.stderr).toBe(
      `TIA workspace run did not succeed; see ${output}\n`,
    )
    expect(result.stdout).toBe('')
    expect(JSON.parse(readFileSync(output, 'utf8')).success).toBe(false)
  })

  test('tiacore run stays silent when the receipt goes to stdout', async () => {
    const root = scratch()
    const config = join(root, 'tiacore.config.mjs')
    writeFileSync(config, failingLane)
    for (const extra of [[], ['--output', '-']]) {
      const result = await captured(['run', '--config', config, ...extra])
      expect(result.outcome).toEqual({ code: 1, silent: true })
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout).success).toBe(false)
    }
  })

  test.skipIf(process.getuid?.() === 0)(
    'tiacore doctor names the report file on stderr',
    async () => {
      const root = scratch()
      const locked = join(root, 'locked')
      mkdirSync(locked)
      chmodSync(locked, 0o500)
      const output = join(root, 'doctor.json')
      try {
        const result = await captured([
          'doctor',
          '--cache-dir',
          join(locked, '.tia'),
          '--output',
          output,
        ])
        expect(result.outcome).toEqual({ code: 1, silent: true })
        expect(result.stderr).toContain(
          `tiacore doctor found problems; see ${output}\n`,
        )
        expect(JSON.parse(readFileSync(output, 'utf8')).ok).toBe(false)
      } finally {
        chmodSync(locked, 0o700)
      }
    },
  )
})

describe('tiacore plan', () => {
  test('creates the directories of an --output path', async () => {
    const root = scratch()
    const output = join(root, 'reports', 'tia', 'plan.json')
    const outcome = await execute([...planInputs(root), '--output', output])
    expect(outcome).toEqual({ code: 0 })
    expect(JSON.parse(readFileSync(output, 'utf8'))).toHaveProperty('selected')
  })

  test('names the policy field that does not decode', async () => {
    const root = scratch()
    const policy = join(root, 'policy.json')
    writeFileSync(policy, JSON.stringify({ forceFull: 'yes' }))
    const outcome = await execute([...planInputs(root), '--policy', policy])
    expect(outcome.code).toBe(1)
    expect(outcome.message).toBe(
      'TIA execution policy forceFull Expected boolean',
    )
  })
})
