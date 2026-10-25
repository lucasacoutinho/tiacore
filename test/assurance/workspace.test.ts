import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { runCli } from '../../src/entries/cli.ts'
import { TiaWorkspaceRunner, tia } from '../../src/entries/workspace.ts'
import { assertNoLeak } from '../support/leak.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tiacore-workspace-'))
  temporaryDirectories.push(directory)
  return directory
}

function delayedRunner(
  state: { active: number; maximum: number },
  duration: number,
  success = true,
): { run(): Promise<{ success: boolean }> } {
  return {
    async run() {
      state.active += 1
      state.maximum = Math.max(state.maximum, state.active)
      await new Promise((resolve) => setTimeout(resolve, duration))
      state.active -= 1
      return { success }
    },
  }
}

const node = (code: string) => ({
  arguments: ['-e', code],
  command: process.execPath,
})

describe('workspace coordinator', () => {
  test('runs independent lanes concurrently and serializes resource locks', async () => {
    const all = { active: 0, maximum: 0 }
    const device = { active: 0, maximum: 0 }
    const deviceRunner = () => ({
      async run() {
        device.active += 1
        device.maximum = Math.max(device.maximum, device.active)
        const result = await delayedRunner(all, 20).run()
        device.active -= 1
        return result
      },
    })
    const result = await tia({
      concurrency: 3,
      lanes: [
        { id: 'mobile-a', resourceLocks: ['device'], runner: deviceRunner() },
        { id: 'mobile-b', resourceLocks: ['device'], runner: deviceRunner() },
        { id: 'unit', runner: delayedRunner(all, 20) },
      ],
    }).run()

    expect(result.success).toBe(true)
    expect(all.maximum).toBe(2)
    expect(device.maximum).toBe(1)
  })

  test('blocks dependents when a required lane fails', async () => {
    const state = { active: 0, maximum: 0 }
    const result = await tia({
      lanes: [
        { id: 'build', runner: delayedRunner(state, 1, false) },
        { dependsOn: ['build'], id: 'qa', runner: delayedRunner(state, 1) },
      ],
    }).run()

    expect(result.success).toBe(false)
    expect(result.lanes.map((lane) => lane.status)).toEqual([
      'failed',
      'blocked',
    ])
  })

  test('runs command lanes and records their exit status', async () => {
    const result = await tia({
      lanes: [
        {
          arguments: ['-e', 'process.exit(0)'],
          command: process.execPath,
          id: 'command',
        },
      ],
    }).run()

    expect(result.success).toBe(true)
    expect(result.lanes[0]?.status).toBe('passed')
  })

  test('loads a workspace through the CLI run command', async () => {
    const directory = await scratch()
    const output = join(directory, 'result.json')
    const fixture = fileURLToPath(
      new URL('./fixtures/workspace-config.mjs', import.meta.url),
    )

    await runCli(['run', '--config', fixture, '--output', output])

    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      lanes: [{ id: 'configured-command', status: 'passed' }],
      success: true,
    })
  })
})

describe('workspace lanes', () => {
  test('records non-zero and signal exits and spawn failures', async () => {
    const result = await tia({
      lanes: [
        { id: 'zero', ...node('process.exit(0)') },
        { id: 'three', ...node('process.exit(3)') },
        { id: 'signal', ...node('process.kill(process.pid, "SIGKILL")') },
        { command: 'tiacore-no-such-command', id: 'missing' },
        { id: 'bad-cwd', cwd: 'no/such/dir', ...node('0') },
      ],
    }).run()
    const byId = Object.fromEntries(result.lanes.map((lane) => [lane.id, lane]))
    expect(byId['zero']).toMatchObject({
      result: { status: 0 },
      status: 'passed',
    })
    expect(byId['three']).toMatchObject({
      result: { status: 3 },
      status: 'failed',
    })
    expect(byId['signal']).toMatchObject({
      result: { status: 128 },
      status: 'failed',
    })
    expect(byId['missing']).toMatchObject({ status: 'failed' })
    expect(byId['missing']?.error).toContain('ENOENT')
    expect(byId['missing']).not.toHaveProperty('result')
    expect(byId['bad-cwd']).toMatchObject({ status: 'failed' })
    expect(byId['bad-cwd']?.error).toBeTruthy()
  })

  test('passes environment and resolves cwd against the root', async () => {
    const directory = await scratch()
    await writeFile(join(directory, 'marker'), '')
    const result = await tia({
      lanes: [
        {
          environment: { TIA_LANE: 'yes' },
          id: 'env',
          ...node(
            'process.exit(process.env.TIA_LANE === "yes" && require("fs").existsSync("marker") ? 0 : 1)',
          ),
        },
      ],
      root: directory,
    }).run()
    expect(result.success).toBe(true)
  })

  test('stores runner results verbatim and fails on success false', async () => {
    const payload = { detail: [1, 2], success: true }
    const result = await tia({
      lanes: [
        { id: 'ok', runner: { run: async () => payload } },
        { id: 'plain', runner: { run: async () => 'text' } },
        { id: 'no', runner: { run: async () => ({ success: false }) } },
        { id: 'status', runner: { run: async () => ({ status: 2 }) } },
      ],
    }).run()
    expect(result.lanes.map((lane) => lane.status)).toEqual([
      'passed',
      'passed',
      'failed',
      'failed',
    ])
    expect(result.lanes[0]?.result).toBe(payload)
  })

  test('records a throwing or rejecting runner as failed with its message', async () => {
    const result = await tia({
      lanes: [
        {
          id: 'sync',
          runner: {
            run: () => {
              throw new Error('sync boom')
            },
          },
        },
        {
          id: 'reject',
          runner: { run: () => Promise.reject(new Error('async boom')) },
        },
        { id: 'text', runner: { run: () => Promise.reject('plain text') } },
      ],
    }).run()
    expect(result.lanes.map((lane) => lane.error)).toEqual([
      'sync boom',
      'async boom',
      'plain text',
    ])
    expect(result.lanes.every((lane) => lane.status === 'failed')).toBe(true)
    expect(result.lanes[0]).not.toHaveProperty('result')
  })

  test('accepts runners of any class, structurally', async () => {
    class Foreign {
      run() {
        return Promise.resolve({ success: true })
      }
    }
    const result = await tia({
      lanes: [{ id: 'foreign', runner: new Foreign() }],
    }).run()
    expect(result.success).toBe(true)
  })

  test('can run the same runner twice', async () => {
    const runner = tia({
      lanes: [{ id: 'a', runner: { run: async () => ({}) } }],
    })
    expect((await runner.run()).success).toBe(true)
    expect((await runner.run()).success).toBe(true)
  })

  test('returns success for no lanes', async () => {
    expect(await tia({ lanes: [] }).run()).toEqual({ lanes: [], success: true })
  })
})

describe('workspace validation', () => {
  const ok = { run: async () => ({}) }

  test.each([
    [[{ id: ' ', runner: ok }], 'duplicate or empty TIA workspace lane id:  '],
    [
      [
        { id: 'a', runner: ok },
        { id: 'a', runner: ok },
      ],
      'duplicate or empty TIA workspace lane id: a',
    ],
    [
      [{ id: 'a' }],
      'TIA workspace lane a must define exactly one command or runner',
    ],
    [
      [{ command: 'x', id: 'a', runner: ok }],
      'TIA workspace lane a must define exactly one command or runner',
    ],
    [
      [{ dependsOn: ['b'], id: 'a', runner: ok }],
      'TIA workspace lane a depends on unknown lane b',
    ],
    [
      [{ dependsOn: ['a'], id: 'a', runner: ok }],
      'TIA workspace lane dependency cycle includes a',
    ],
    [
      [
        { dependsOn: ['b'], id: 'a', runner: ok },
        { dependsOn: ['a'], id: 'b', runner: ok },
      ],
      'TIA workspace lane dependency cycle includes a',
    ],
  ])('rejects lanes %j', (lanes, message) => {
    expect(() => tia({ lanes })).toThrow(message)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects concurrency %s at decode',
    (concurrency) => {
      expect(() => tia({ concurrency, lanes: [] })).toThrow(/concurrency/)
    },
  )

  test('rejects lanes that are not objects with a run() method', () => {
    expect(() => tia({ lanes: [{ id: 'a', runner: {} as never }] })).toThrow(
      /run\(\)/,
    )
    expect(() => tia({ lanes: 'nope' as never })).toThrow(/lanes/)
  })

  test.each([0, -3, 1.9])(
    'clamps concurrency %s to one lane at a time',
    async (concurrency) => {
      const state = { active: 0, maximum: 0 }
      await tia({
        concurrency,
        lanes: [
          { id: 'a', runner: delayedRunner(state, 10) },
          { id: 'b', runner: delayedRunner(state, 10) },
        ],
      }).run()
      expect(state.maximum).toBe(1)
    },
  )
})

describe('workspace scheduling', () => {
  test('does not start a lane until every dependency settled', async () => {
    const order: string[] = []
    const record = (name: string, delay: number, success: boolean) => ({
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, delay))
        order.push(name)
        return { success }
      },
    })
    const result = await tia({
      lanes: [
        { id: 'fast-fail', runner: record('fast-fail', 1, false) },
        { id: 'slow', runner: record('slow', 40, true) },
        {
          dependsOn: ['fast-fail', 'slow'],
          id: 'after',
          runner: record('after', 1, true),
        },
      ],
    }).run()
    expect(order).toEqual(['fast-fail', 'slow'])
    expect(result.lanes[2]).toMatchObject({
      duration: 0,
      error: 'dependency fast-fail did not pass',
      status: 'blocked',
    })
  })

  test('blocks unstarted lanes after a failure when failFast is set', async () => {
    const state = { active: 0, maximum: 0 }
    const result = await tia({
      concurrency: 1,
      failFast: true,
      lanes: [
        { id: 'a', runner: delayedRunner(state, 1, false) },
        { id: 'b', runner: delayedRunner(state, 1) },
      ],
    }).run()
    expect(result.lanes[1]).toMatchObject({
      error: 'workspace stopped after an earlier lane failed',
      status: 'blocked',
    })
  })

  test('a lane waiting on a lock does not block later lanes', async () => {
    const started: string[] = []
    const lane = (id: string, locks: string[], delay: number) => ({
      id,
      resourceLocks: locks,
      runner: {
        run: async () => {
          started.push(id)
          await new Promise((resolve) => setTimeout(resolve, delay))
          return {}
        },
      },
    })
    await tia({
      concurrency: 3,
      lanes: [lane('a', ['x'], 40), lane('b', ['x'], 1), lane('c', [], 1)],
    }).run()
    expect(started).toEqual(['a', 'c', 'b'])
  })

  test('leaks nothing across repeated runs', async () => {
    const workspace = tia({
      concurrency: 2,
      lanes: [
        { id: 'a', ...node('0') },
        { dependsOn: ['a'], id: 'b', runner: { run: async () => ({}) } },
      ],
    })
    await assertNoLeak(() => workspace.run(), {
      bytesPerOperation: 4_096,
      iterations: 20,
    })
    expect((await workspace.run()).success).toBe(true)
  }, 60_000)
})

async function config(source: string): Promise<string> {
  const directory = await scratch()
  const path = join(directory, 'tiacore.config.mjs')
  await writeFile(path, source)
  return path
}

describe('workspace config', () => {
  test('uses a named workspace export when there is no default', async () => {
    const path = await config(
      `export const workspace = { lanes: [{ id: 'n', command: ${JSON.stringify(process.execPath)}, arguments: ['-e', '0'] }] }`,
    )
    const output = join(path, '..', 'out.json')
    await runCli(['run', '--config', path, '--output', output])
    expect(JSON.parse(await readFile(output, 'utf8')).success).toBe(true)
  })

  test('runs a runner-like default export from any class copy', async () => {
    const path = await config(
      `export default { run: async () => ({ lanes: [], success: true }) }`,
    )
    const output = join(path, '..', 'out.json')
    await runCli(['run', '--config', path, '--output', output])
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      lanes: [],
      success: true,
    })
  })

  test('accepts a TiaWorkspaceRunner instance', async () => {
    const path = await config(
      `import { tia } from ${JSON.stringify(new URL('../../src/entries/workspace.ts', import.meta.url).href)}\nexport default tia({ lanes: [] })`,
    )
    const output = join(path, '..', 'out.json')
    await runCli(['run', '--config', path, '--output', output])
    expect(JSON.parse(await readFile(output, 'utf8')).success).toBe(true)
    expect(tia({ lanes: [] })).toBeInstanceOf(TiaWorkspaceRunner)
  })

  test('fails when the module exports neither default nor workspace', async () => {
    const path = await config('export const other = 1')
    await expect(runCli(['run', '--config', path])).rejects.toThrow(
      `TIA workspace config ${path} must export default or workspace`,
    )
  })

  test('rejects non-finite concurrency in a config module', async () => {
    const path = await config(
      'export default { concurrency: Infinity, lanes: [] }',
    )
    await expect(runCli(['run', '--config', path])).rejects.toThrow(
      /concurrency/,
    )
  })

  test('still writes the receipt when a lane fails, then fails', async () => {
    const path = await config(
      `export default { lanes: [{ id: 'bad', command: ${JSON.stringify(process.execPath)}, arguments: ['-e', 'process.exit(1)'] }] }`,
    )
    const output = join(path, '..', 'out.json')
    // As in 1.x, a failed run is reported by the receipt and the exit code only.
    const previous = process.exitCode
    try {
      await runCli(['run', '--config', path, '--output', output])
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previous
    }
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      lanes: [{ id: 'bad', status: 'failed' }],
      success: false,
    })
  })
})
