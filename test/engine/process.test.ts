import { tmpdir } from 'node:os'

import { afterAll, describe, expect, test } from 'vitest'

import {
  inheritedEnvironment,
  runAttached,
  runProcess,
  type ProcessSpec,
} from '../../src/engine/process.ts'
import { disposeHost, runPromise } from '../../src/host/runtime.ts'

afterAll(disposeHost)

function node(
  source: string,
  overrides: Partial<ProcessSpec> = {},
): ProcessSpec {
  return {
    args: ['-e', source],
    command: process.execPath,
    cwd: tmpdir(),
    env: inheritedEnvironment(),
    stdio: 'capture',
    ...overrides,
  }
}

const run = (source: string, overrides: Partial<ProcessSpec> = {}) =>
  runPromise(runProcess(node(source, overrides)))

describe('runProcess outcome', () => {
  test('collects stdout and stderr together and reports the exit code', async () => {
    const outcome = await run(
      "process.stdout.write('out '); process.stderr.write('err'); process.exit(3)",
    )
    expect(outcome).toEqual({
      code: 3,
      output: 'out err',
      overflowed: false,
      status: 3,
      timedOut: false,
    })
  })

  test('maps a signal to status 128 and no code', async () => {
    const outcome = await run("process.kill(process.pid, 'SIGKILL')")
    expect(outcome).toMatchObject({ code: null, status: 128, timedOut: false })
  })

  test('a timeout ends the run with no code and a status of 128', async () => {
    const outcome = await run('setTimeout(() => {}, 60000)', {
      timeoutMs: 200,
    })
    expect(outcome).toMatchObject({ code: null, status: 128, timedOut: true })
  })

  test('stops a child that writes past maxOutputBytes', async () => {
    const outcome = await run(
      "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)",
      { maxOutputBytes: 100_000, timeoutMs: 30_000 },
    )
    expect(outcome.overflowed).toBe(true)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.output.length).toBeLessThanOrEqual(100_000)
  })

  test('a missing command is a TiaIo failure with the spawn error', async () => {
    await expect(
      runPromise(
        runProcess({
          args: [],
          command: 'tiacore-no-such-binary',
          cwd: tmpdir(),
          env: inheritedEnvironment(),
          stdio: 'discard',
        }),
      ),
    ).rejects.toThrow(/ENOENT/u)
  })

  test('closes the stdin of a captured child', async () => {
    const outcome = await run(
      "process.stdout.write(String(require('node:fs').readFileSync(0).length))",
    )
    expect(outcome.output).toBe('0')
  })
})

describe('runProcess environment', () => {
  const print = 'process.stdout.write(JSON.stringify(process.env))'

  test('the child sees exactly the env it is given', async () => {
    const outcome = await run(print, { env: { ONLY: '1' } })
    expect(JSON.parse(outcome.output)).toEqual({ ONLY: '1' })
  })

  test('inheritedEnvironment applies an overlay and drops undefined values', async () => {
    process.env['TIA_PROCESS_TEST_KEPT'] = 'kept'
    process.env['TIA_PROCESS_TEST_DROPPED'] = 'dropped'
    try {
      const outcome = await run(print, {
        env: inheritedEnvironment({
          TIA_PROCESS_TEST_ADDED: 'added',
          TIA_PROCESS_TEST_DROPPED: undefined,
        }),
      })
      expect(JSON.parse(outcome.output)).toMatchObject({
        TIA_PROCESS_TEST_ADDED: 'added',
        TIA_PROCESS_TEST_KEPT: 'kept',
      })
      expect(JSON.parse(outcome.output)).not.toHaveProperty(
        'TIA_PROCESS_TEST_DROPPED',
      )
    } finally {
      delete process.env['TIA_PROCESS_TEST_KEPT']
      delete process.env['TIA_PROCESS_TEST_DROPPED']
    }
  })
})

describe.skipIf(process.platform === 'win32')('process groups', () => {
  // The child asks `ps` for its own process group and for its parent's.
  const report = `
    const { execFileSync } = require('node:child_process')
    const group = (pid) =>
      Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    process.stdout.write(JSON.stringify({
      group: group(process.pid),
      parentGroup: group(process.ppid),
      pid: process.pid,
    }))
  `

  test('an own group is a group of the child alone', async () => {
    const outcome = await run(report, { group: 'own' })
    const { group, parentGroup, pid } = JSON.parse(outcome.output)
    expect(group).toBe(pid)
    expect(group).not.toBe(parentGroup)
  })

  test('a shared group is ours, so a terminal Ctrl-C reaches the child', async () => {
    const outcome = await run(report, { group: 'shared' })
    const { group, parentGroup, pid } = JSON.parse(outcome.output)
    expect(group).toBe(parentGroup)
    expect(group).not.toBe(pid)
  })
})

describe('runAttached', () => {
  test('returns the exit status of the command', async () => {
    const status = await runPromise(
      runAttached({
        args: ['-e', 'process.exit(7)'],
        command: process.execPath,
        cwd: tmpdir(),
        env: inheritedEnvironment(),
      }),
    )
    expect(status).toBe(7)
  })

  test('reports 128 for a command ended by a signal', async () => {
    const status = await runPromise(
      runAttached({
        args: ['-e', "process.kill(process.pid, 'SIGKILL')"],
        command: process.execPath,
        cwd: tmpdir(),
        env: inheritedEnvironment(),
      }),
    )
    expect(status).toBe(128)
  })
})
