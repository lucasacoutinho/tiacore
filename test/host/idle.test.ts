import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as Effect from 'effect/Effect'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  disposeHost,
  IDLE_DISPOSE_MS,
  runPromise,
} from '../../src/host/runtime.ts'

const k6Entry = pathToFileURL(
  fileURLToPath(new URL('../../dist/entries/k6.js', import.meta.url)),
).href

const directories: string[] = []
const saved: Record<string, string | undefined> = {}

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-idle-'))
  directories.push(path)
  return path
}

function setEnvironment(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
}

beforeEach(async () => {
  await disposeHost()
})
afterEach(async () => {
  await disposeHost()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
afterAll(() => {
  for (const path of directories.splice(0))
    rmSync(path, { force: true, recursive: true })
})

const stage = Effect.fn('tia.test.idle')(function* (value: number) {
  yield* Effect.annotateCurrentSpan('value', value)
  return value
})

async function until(ready: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function spanValues(path: string): number[] {
  const trace: { spans: { attributes: { value: number } }[] } = JSON.parse(
    readFileSync(path, 'utf8'),
  )
  return trace.spans.map((span) => span.attributes.value)
}

describe('a runtime that exports', () => {
  test('closes when idle, writes what it holds, and rebuilds for the next run', async () => {
    const trace = join(scratch(), 'trace.json')
    setEnvironment({ TIACORE_TRACE_FILE: trace })
    await runPromise(stage(1))
    expect(existsSync(trace)).toBe(false)
    await until(() => existsSync(trace))
    expect(spanValues(trace)).toEqual([1])
    // The next run builds a new runtime; the file then holds both runs.
    await runPromise(stage(2))
    await until(() => spanValues(trace).length === 2)
    expect(spanValues(trace)).toEqual([1, 2])
  })

  test('waits while runs are in flight and after each run restarts the clock', async () => {
    const trace = join(scratch(), 'trace.json')
    setEnvironment({ TIACORE_TRACE_FILE: trace })
    const started = Date.now()
    await runPromise(stage(1))
    await new Promise((resolve) => setTimeout(resolve, IDLE_DISPOSE_MS / 2))
    await runPromise(stage(2))
    await until(() => existsSync(trace))
    expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_DISPOSE_MS * 1.4)
    expect(spanValues(trace)).toEqual([1, 2])
  })

  test('a runtime without exporters is not closed behind the caller’s back', async () => {
    await runPromise(stage(1))
    await new Promise((resolve) => setTimeout(resolve, IDLE_DISPOSE_MS + 200))
    await expect(runPromise(stage(2))).resolves.toBe(2)
  })
})

describe('a process that never disposes the runtime', () => {
  test('still writes the file exporters when it exits', () => {
    const directory = scratch()
    mkdirSync(join(directory, 'k6'))
    const metrics = join(directory, 'metrics.prom')
    const trace = join(directory, 'trace.json')
    const script = `
      import { discoverK6Suites } from ${JSON.stringify(k6Entry)}
      await discoverK6Suites({ profiles: 'k6', project: 'p', root: ${JSON.stringify(directory)} })
      process.exit(0)
    `
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          TIACORE_METRICS_FILE: metrics,
          TIACORE_TRACE_FILE: trace,
        },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(metrics, 'utf8')).toMatch(
      /tia_runs_total\{outcome="success"\} 1/u,
    )
    expect(JSON.parse(readFileSync(trace, 'utf8'))).toMatchObject({
      spans: expect.any(Array),
    })
  })
})
