import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as PrometheusMetrics from 'effect/observability/PrometheusMetrics'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'

import { MAX_CRASH_REPORTS, writeCrashReport } from '../../src/host/crash.ts'
import { observeLayer } from '../../src/host/observe.ts'
import { disposeHost, recordSpans, runPromise } from '../../src/host/runtime.ts'
import { TiaInvalid } from '../../src/wire/errors.ts'
import { activeHandles, assertNoLeak, waitForHandles } from '../support/leak.ts'

// NF-MEM: everything the host layer keeps alive between runs is released or
// bounded. The resources are the process-wide runtime, the span recorder, the
// metric registry, the exporters (trace file, metrics file, OTLP) and the crash
// report directory. The devtools client and server are in devtools-server.test.ts.

const directories: string[] = []
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-host-leak-'))
  directories.push(path)
  return path
}

const saved: Record<string, string | undefined> = {}
function setEnvironment(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
}

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

const stage = Effect.fn('tia.test.stage')(function* (value: number) {
  yield* Effect.annotateCurrentSpan('value', value)
  return value * 2
})

describe('the process-wide runtime', () => {
  test('building and disposing it repeatedly retains nothing', async () => {
    const result = await assertNoLeak(
      async () => {
        await runPromise(stage(1))
        await disposeHost()
      },
      { bytesPerOperation: 8_192, iterations: 100 },
    )
    expect(result.bytesPerOperation).toBeLessThan(8_192)
  })

  test('with the trace and metrics files on, each dispose writes and releases', async () => {
    const directory = scratch()
    setEnvironment({
      TIACORE_METRICS_FILE: join(directory, 'metrics.prom'),
      TIACORE_TRACE_FILE: join(directory, 'trace.json'),
    })
    const result = await assertNoLeak(
      async () => {
        for (let index = 0; index < 5; index += 1)
          await runPromise(stage(index))
        await disposeHost()
      },
      { bytesPerOperation: 16_384, iterations: 30 },
    )
    expect(result.bytesPerOperation).toBeLessThan(16_384)
    expect(readdirSync(directory).sort()).toEqual([
      'metrics.prom',
      'trace.json',
    ])
  })

  test('a failing run releases the same as a passing one', async () => {
    const result = await assertNoLeak(
      async () => {
        await runPromise(
          Effect.fail(new TiaInvalid({ message: 'invalid' })),
        ).catch(() => undefined)
        await disposeHost()
      },
      { bytesPerOperation: 8_192, iterations: 60 },
    )
    expect(result.bytesPerOperation).toBeLessThan(8_192)
  })
})

describe('the span recorder', () => {
  test('stops recording when its body ends and holds nothing after', async () => {
    let spans = 0
    const result = await assertNoLeak(
      async () => {
        const recorded = await recordSpans(() => runPromise(stage(1)))
        spans = recorded.spans.length
      },
      { bytesPerOperation: 1_024, iterations: 500 },
    )
    expect(spans).toBe(1)
    expect(result.bytesPerOperation).toBeLessThan(1_024)
    // A run outside the recorder is not recorded anywhere.
    const outside = await recordSpans(async () => undefined)
    await runPromise(stage(2))
    expect(outside.spans).toEqual([])
  })
})

const series = async () =>
  (await Effect.runPromise(PrometheusMetrics.format()))
    .split('\n')
    .filter((line) => line.startsWith('tia_runs_total'))

describe('the metric registry', () => {
  test('keeps one series per outcome however many runs report', async () => {
    // Metrics are collected only when an exporter will read them.
    setEnvironment({
      TIACORE_METRICS_FILE: join(scratch(), 'metrics.prom'),
    })
    for (let index = 0; index < 20; index += 1) await runPromise(stage(index))
    await runPromise(Effect.fail(new TiaInvalid({ message: 'invalid' }))).catch(
      () => undefined,
    )
    const before = await series()
    const result = await assertNoLeak(() => runPromise(stage(1)), {
      bytesPerOperation: 256,
      iterations: 2_000,
    })
    expect(result.bytesPerOperation).toBeLessThan(256)
    const after = await series()
    expect(after.map((line) => line.split(' ')[0])).toEqual(
      before.map((line) => line.split(' ')[0]),
    )
    expect(after.length).toBeGreaterThanOrEqual(2)
  })
})

describe('crash reports', () => {
  test('keep the newest reports and nothing else', async () => {
    const directory = scratch()
    let tick = 0
    const result = await assertNoLeak(
      () => {
        tick += 1
        writeCrashReport(Cause.die(new RangeError('boom')), {
          argv: ['verify'],
          directory,
          now: new Date(Date.UTC(2026, 0, 1, 0, 0, tick)),
        })
      },
      { bytesPerOperation: 2_048, iterations: 60 },
    )
    expect(result.bytesPerOperation).toBeLessThan(2_048)
    const names = readdirSync(directory).sort()
    expect(names).toHaveLength(MAX_CRASH_REPORTS)
    // The newest survive: the last report is the last write.
    expect(names.at(-1)).toContain(
      new Date(Date.UTC(2026, 0, 1, 0, 0, tick))
        .toISOString()
        .replaceAll(':', '-'),
    )
  })

  test('leave other files in the directory alone', () => {
    const directory = scratch()
    for (let index = 0; index < MAX_CRASH_REPORTS + 5; index += 1) {
      writeCrashReport(Cause.die('x'), {
        argv: [],
        directory,
        now: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })
    }
    expect(
      readdirSync(directory).filter((name) => name.startsWith('crash-')),
    ).toHaveLength(MAX_CRASH_REPORTS)
  })
})

describe('the OTLP exporter', () => {
  let server: Server
  let received: { body: string; url: string | undefined }[] = []
  let status = 200

  let baseline = 0
  beforeEach(async () => {
    received = []
    status = 200
    server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          received.push({
            body: Buffer.concat(chunks).toString('utf8'),
            url: request.url,
          })
          response.statusCode = status
          response.end('{}')
        })
      },
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseline = activeHandles()
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** Disposing the runtime must free the timers and sockets the exporter used. */
  async function released(
    runtime: ManagedRuntime.ManagedRuntime<never, never>,
  ) {
    await runtime.dispose()
    server.closeAllConnections()
    // The server socket and its listener stay; keep-alive clients leave within seconds.
    await waitForHandles(baseline)
  }

  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  test('sends the finished spans to the collector when the runtime closes', async () => {
    const runtime = ManagedRuntime.make(observeLayer({ otlp: url() }))
    await runtime.runPromise(stage(5))
    await runtime.dispose()
    const traces = received.filter((request) => request.url === '/v1/traces')
    expect(traces).toHaveLength(1)
    expect(traces[0]?.body).toContain('tia.test.stage')
    expect(traces[0]?.body).toContain('tiacore')
  })

  test('buffers a bounded number of spans while the collector is down', async () => {
    status = 503
    const runtime = ManagedRuntime.make(observeLayer({ otlp: url() }))
    // Keep-alive sockets close on their own timer, so handles are checked after.
    const result = await assertNoLeak(() => runtime.runPromise(stage(1)), {
      batches: 3,
      bytesPerOperation: 2_048,
      handles: false,
      iterations: 2_500,
    })
    expect(result.bytesPerOperation).toBeLessThan(2_048)
    await released(runtime)
  }, 120_000)

  test('retains nothing per span while the collector accepts them', async () => {
    const runtime = ManagedRuntime.make(observeLayer({ otlp: url() }))
    const result = await assertNoLeak(() => runtime.runPromise(stage(1)), {
      batches: 3,
      bytesPerOperation: 2_048,
      handles: false,
      iterations: 2_500,
    })
    expect(result.bytesPerOperation).toBeLessThan(2_048)
    await released(runtime)
    expect(received.length).toBeGreaterThan(0)
  }, 120_000)
})

describe('the leak check itself', () => {
  test('fails on timers that are never cleared', async () => {
    const timers: NodeJS.Timeout[] = []
    try {
      await expect(
        assertNoLeak(() => timers.push(setInterval(() => undefined, 1e6)), {
          bytesPerOperation: 1e6,
          iterations: 10,
        }),
      ).rejects.toThrow(/active handles grew/u)
    } finally {
      for (const timer of timers) clearInterval(timer)
    }
  })

  test('fails on file descriptors that are never closed', async () => {
    if (process.platform === 'win32') return
    const opened: number[] = []
    try {
      await expect(
        assertNoLeak(() => opened.push(openSync(process.execPath, 'r')), {
          bytesPerOperation: 1e6,
          iterations: 10,
        }),
      ).rejects.toThrow(/file descriptors grew/u)
    } finally {
      for (const descriptor of opened) closeSync(descriptor)
    }
  })
})
