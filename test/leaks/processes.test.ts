import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { runProcess } from '../../src/assurance/process.ts'
import { executeSuites } from '../../src/engine/scheduling.ts'
import { executeAdapterCertification } from '../../src/entries/conformance.ts'
import {
  disposeHost,
  type HostServices,
  runPromise,
} from '../../src/host/runtime.ts'
import { childEnvironment, runChild } from '../../src/runners/shared/process.ts'
import type { TiaError } from '../../src/wire/errors.ts'
import { assertNoLeak } from '../support/leak.ts'

// NF-MEM: every path that ends a child early (interruption, which is what a
// timeout does, and output overflow) must kill it, and its grandchildren, and
// release its pipes.

let directory = ''

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'tiacore-process-leak-'))
})

afterAll(async () => {
  await disposeHost()
  rmSync(directory, { force: true, recursive: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(
  pids: readonly number[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(pids.filter(alive)).toEqual([])
}

/**
 * Writes its pid, then starts a grandchild that writes its own and sleeps;
 * `mode` decides what the child does after that.
 */
function script(
  tag: string,
  mode: 'flood' | 'sleep',
  withGrandchild = true,
): string {
  const pids = JSON.stringify(join(directory, tag))
  const grandchild = `require('node:fs').appendFileSync(${pids}, process.pid + '\\n'); setTimeout(() => {}, 60000)`
  return `
const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
appendFileSync(${pids}, process.pid + '\\n')
${withGrandchild ? `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })` : ''}
${mode === 'flood' ? "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)" : 'setTimeout(() => {}, 60000)'}
`
}

function pidsOf(tag: string): number[] {
  try {
    return readFileSync(join(directory, tag), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map(Number)
  } catch {
    return []
  }
}

/**
 * Starts `program`, waits until the child and its grandchildren have written
 * `expected` pids, then interrupts it, which is what a timeout does. The wait
 * is for the processes, not for a clock, so a loaded machine cannot make the
 * test pass without having started anything.
 */
const interruptOnceStarted = (
  tag: string,
  expected: number,
  program: Effect.Effect<unknown, TiaError, HostServices>,
) =>
  runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(program)
      const deadline = Date.now() + 60_000
      while (pidsOf(tag).length < expected && Date.now() < deadline) {
        yield* Effect.sleep(10)
      }
      yield* Fiber.interrupt(fiber)
      expect(pidsOf(tag)).toHaveLength(expected)
    }),
  )

describe('child processes that end early', () => {
  test('an interrupted run is killed with its grandchild, over and over', async () => {
    const tags: string[] = []
    let tick = 0
    const result = await assertNoLeak(
      async () => {
        tick += 1
        const tag = `child-${tick}`
        tags.push(tag)
        await interruptOnceStarted(
          tag,
          2,
          runChild({
            args: ['-e', script(tag, 'sleep')],
            command: process.execPath,
            cwd: directory,
            env: childEnvironment(),
            stdio: 'capture',
          }),
        )
      },
      { batches: 2, bytesPerOperation: 65_536, iterations: 6 },
    )
    expect(result.bytesPerOperation).toBeLessThan(65_536)
    await gone(tags.flatMap(pidsOf))
  }, 180_000)

  test('an interrupted or overflowing assurance process is killed with its grandchild', async () => {
    const tags: string[] = []
    let tick = 0
    const result = await assertNoLeak(
      async () => {
        tick += 1
        const interruptedTag = `interrupted-${tick}`
        const floodTag = `flood-${tick}`
        tags.push(interruptedTag, floodTag)
        await interruptOnceStarted(
          interruptedTag,
          2,
          runProcess({
            args: ['-e', script(interruptedTag, 'sleep')],
            command: process.execPath,
            cwd: directory,
            env: undefined,
            stdio: 'capture',
          }),
        )
        const flooded = await runPromise(
          runProcess({
            args: ['-e', script(floodTag, 'flood')],
            command: process.execPath,
            cwd: directory,
            env: undefined,
            maxOutputBytes: 256 * 1024,
            stdio: 'capture',
            timeoutMs: 60_000,
          }),
        )
        expect(flooded.overflowed).toBe(true)
      },
      { batches: 2, bytesPerOperation: 65_536, iterations: 5 },
    )
    expect(result.bytesPerOperation).toBeLessThan(65_536)
    await gone(tags.flatMap(pidsOf))
  }, 180_000)

  test('an interrupted external-suite run kills its child and releases its fibers', async () => {
    const tags: string[] = []
    let tick = 0
    const result = await assertNoLeak(
      async () => {
        tick += 1
        const tag = `suite-${tick}`
        tags.push(tag)
        await interruptOnceStarted(
          tag,
          1,
          executeSuites({
            // Suites run in this process's group so a terminal's Ctrl-C reaches
            // them (detached: false), so only the child itself is killed.
            argumentsFor: () => ['-e', script(tag, 'sleep', false)],
            command: process.execPath,
            cwd: directory,
            maxConcurrency: 1,
            suites: [{ adapter: 'fake', file: 'a.js', id: 'a', project: 'p' }],
          }),
        )
      },
      { batches: 2, bytesPerOperation: 65_536, iterations: 5 },
    )
    expect(result.bytesPerOperation).toBeLessThan(65_536)
    await gone(tags.flatMap(pidsOf))
  }, 180_000)

  test('executable certification runs and releases one process per scenario', async () => {
    const result = await assertNoLeak(
      async () => {
        const receipt = await executeAdapterCertification({
          adapter: 'leak-adapter',
          capabilityLevel: 'static-impact',
          root: directory,
          runner: { name: 'leak', version: '1' },
          scenarios: [
            {
              arguments: ['-e', 'process.exit(0)'],
              command: process.execPath,
              fixture: 'fixtures/ok',
              id: 'ok',
            },
            {
              arguments: ['-e', 'process.exit(3)'],
              command: process.execPath,
              fixture: 'fixtures/fail',
              id: 'fail',
            },
          ],
          selectionGranularity: 'profile',
          sourceRevision: 'sha256:leak',
        })
        expect(receipt.scenarios.map((scenario) => scenario.passed)).toEqual([
          true,
          false,
        ])
      },
      { batches: 3, bytesPerOperation: 65_536, iterations: 10 },
    )
    expect(result.bytesPerOperation).toBeLessThan(65_536)
  }, 180_000)

  test('the checks above notice a child that is left running', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      {
        stdio: 'ignore',
      },
    )
    try {
      expect(alive(child.pid ?? 0)).toBe(true)
      await expect(gone([child.pid ?? 0], 300)).rejects.toThrow(
        /to deeply equal/u,
      )
    } finally {
      child.kill('SIGKILL')
    }
  }, 30_000)
})
