import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { runCli } from '../../../src/cli/index.js'
import { tia } from '../../../src/workspace.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  )
})

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
      lanes: [{
        arguments: ['-e', 'process.exit(0)'],
        command: process.execPath,
        id: 'command',
      }],
    }).run()

    expect(result.success).toBe(true)
    expect(result.lanes[0]?.status).toBe('passed')
  })

  test('loads a workspace through the CLI run command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tiacore-workspace-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'result.json')
    const config = fileURLToPath(
      new URL('../../fixtures/workspace-config.mjs', import.meta.url),
    )

    await runCli(['run', '--config', config, '--output', output])

    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      lanes: [{ id: 'configured-command', status: 'passed' }],
      success: true,
    })
  })
})
