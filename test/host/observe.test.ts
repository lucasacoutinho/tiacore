import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Metric from 'effect/Metric'
import * as Tracer from 'effect/Tracer'
import { afterEach, describe, expect, test } from 'vitest'

import { redactArguments, writeCrashReport } from '../../src/host/crash.ts'
import {
  type FinishedSpan,
  observeConfig,
  observeLayer,
  recordingTracer,
  TRACE_FILE_SPAN_LIMIT,
} from '../../src/host/observe.ts'
import { assertNoLeak } from '../support/leak.ts'
import { TYPESCRIPT_FLAGS } from '../support/node-version.ts'

const directories: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-observe-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { force: true, recursive: true })
})

const stage = Effect.fn('tia.test.stage')(function* (value: number) {
  yield* Effect.annotateCurrentSpan('value', value)
  return value * 2
})

describe('observeConfig', () => {
  test('reads nothing by default', () => {
    expect(observeConfig({})).toEqual({})
  })

  test('maps a truthy devtools flag to the default devtools URL', () => {
    expect(observeConfig({ TIACORE_DEVTOOLS: 'on' })).toEqual({
      devtools: 'ws://localhost:34437',
    })
    expect(observeConfig({ TIACORE_DEVTOOLS: 'ws://10.0.0.2:9000' })).toEqual({
      devtools: 'ws://10.0.0.2:9000',
    })
  })

  test('reads the exporter settings and ignores blank values', () => {
    expect(
      observeConfig({
        TIACORE_METRICS_FILE: 'm.prom',
        TIACORE_OTLP_URL: 'http://collector:4318',
        TIACORE_TRACE_FILE: ' ',
      }),
    ).toEqual({ metricsFile: 'm.prom', otlp: 'http://collector:4318' })
  })
})

describe('observeLayer', () => {
  test('writes finished spans to the trace file when the runtime is disposed', async () => {
    const traceFile = join(directory(), 'trace.json')
    const runtime = ManagedRuntime.make(observeLayer({ traceFile }))
    await expect(runtime.runPromise(stage(21))).resolves.toBe(42)
    await runtime.dispose()
    const trace: { spans: FinishedSpan[] } = JSON.parse(
      readFileSync(traceFile, 'utf8'),
    )
    expect(trace.spans).toEqual([
      expect.objectContaining({
        attributes: { value: 21 },
        name: 'tia.test.stage',
        status: 'success',
      }),
    ])
    expect(trace.spans[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('writes metrics in Prometheus text format when disposed', async () => {
    const metricsFile = join(directory(), 'tiacore.prom')
    const runtime = ManagedRuntime.make(observeLayer({ metricsFile }))
    await runtime.runPromise(Metric.update(Metric.gauge('tia_test_gauge'), 7))
    await runtime.dispose()
    expect(readFileSync(metricsFile, 'utf8')).toMatch(/tia_test_gauge\S* 7/u)
  })

  test.skipIf(process.platform === 'win32')(
    'disposes exporters when a named pipe has no reader',
    () => {
      const pipe = join(directory(), 'output')
      expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
      const program = `
        import * as Effect from 'effect/Effect'
        import * as ManagedRuntime from 'effect/ManagedRuntime'
        import { observeLayer } from './src/host/observe.ts'
        const path = process.argv[1]
        const runtime = ManagedRuntime.make(observeLayer({ traceFile: path, metricsFile: path }))
        await runtime.runPromise(Effect.withSpan(Effect.void, 'closing'))
        await runtime.dispose()
      `
      const child = spawnSync(
        process.execPath,
        [...TYPESCRIPT_FLAGS, '--input-type=module', '-e', program, pipe],
        { encoding: 'utf8', timeout: 8_000 },
      )
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)
    },
  )

  test('flushes active exporters at process exit without reusing an earlier process trace', async () => {
    const dir = directory()
    const traceFile = join(dir, 'trace.json')
    const metricsFile = join(dir, 'metrics.prom')
    const program = `
      import * as Effect from 'effect/Effect'
      import * as ManagedRuntime from 'effect/ManagedRuntime'
      import * as Metric from 'effect/Metric'
      import { observeLayer } from './src/host/observe.ts'
      const runtime = ManagedRuntime.make(observeLayer(${JSON.stringify({ traceFile, metricsFile })}))
      await runtime.runPromise(Effect.withSpan(Metric.update(Metric.gauge('tia_exit_gauge'), 9), 'tia.exit'))
    `
    const child = spawnSync(
      process.execPath,
      [...TYPESCRIPT_FLAGS, '--input-type=module', '-e', program],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    expect(child.status, child.stderr).toBe(0)
    expect(readFileSync(metricsFile, 'utf8')).toMatch(/tia_exit_gauge\S* 9/u)
    expect(JSON.parse(readFileSync(traceFile, 'utf8')).spans).toHaveLength(1)

    const runtime = ManagedRuntime.make(observeLayer({ traceFile }))
    await runtime.runPromise(stage(4))
    await runtime.dispose()
    const trace: { spans: FinishedSpan[] } = JSON.parse(
      readFileSync(traceFile, 'utf8'),
    )
    expect(trace.spans.map((span) => span.name)).toEqual(['tia.test.stage'])
  })

  test('shares trace history across concurrent and reopened runtimes', async () => {
    const traceFile = join(directory(), 'trace.json')
    const first = ManagedRuntime.make(observeLayer({ traceFile }))
    const second = ManagedRuntime.make(observeLayer({ traceFile }))
    await first.runPromise(stage(0))
    await second.runPromise(stage(1))
    await first.dispose()
    await second.runPromise(stage(2))
    await second.dispose()

    const reopened = ManagedRuntime.make(observeLayer({ traceFile }))
    await reopened.runPromise(stage(3))
    await reopened.dispose()
    const trace: { spans: FinishedSpan[] } = JSON.parse(
      readFileSync(traceFile, 'utf8'),
    )
    expect(trace.spans.map((span) => span.attributes['value'])).toEqual([
      0, 1, 2, 3,
    ])
  })

  test('keeps the newest spans across runtime reopenings', async () => {
    const traceFile = join(directory(), 'trace.json')
    const first = ManagedRuntime.make(observeLayer({ traceFile }))
    for (let index = 0; index < TRACE_FILE_SPAN_LIMIT; index += 1)
      await first.runPromise(stage(index))
    await first.dispose()
    const second = ManagedRuntime.make(observeLayer({ traceFile }))
    await second.runPromise(stage(TRACE_FILE_SPAN_LIMIT))
    await second.dispose()
    const trace: { spans: FinishedSpan[] } = JSON.parse(
      readFileSync(traceFile, 'utf8'),
    )
    expect(trace.spans).toHaveLength(TRACE_FILE_SPAN_LIMIT)
    expect(trace.spans[0]?.attributes['value']).toBe(1)
    expect(trace.spans.at(-1)?.attributes['value']).toBe(TRACE_FILE_SPAN_LIMIT)
  })

  test('reloads an evicted history once for concurrent runtime acquisition', async () => {
    const dir = directory()
    const traceFile = join(dir, 'trace.json')
    const first = ManagedRuntime.make(observeLayer({ traceFile }))
    await first.runPromise(stage(0))
    await first.dispose()
    const other = ManagedRuntime.make(
      observeLayer({ traceFile: join(dir, 'other.json') }),
    )
    await other.runPromise(stage(99))
    await other.dispose()

    const a = ManagedRuntime.make(observeLayer({ traceFile }))
    const b = ManagedRuntime.make(observeLayer({ traceFile }))
    await Promise.all([a.runPromise(stage(1)), b.runPromise(stage(2))])
    await Promise.all([a.dispose(), b.dispose()])
    const trace: { spans: FinishedSpan[] } = JSON.parse(
      readFileSync(traceFile, 'utf8'),
    )
    expect(trace.spans.map((span) => span.attributes['value']).sort()).toEqual([
      0, 1, 2,
    ])
  })

  test('reuses the most recently closed trace even if its file is removed', async () => {
    const traceFile = join(directory(), 'trace.json')
    const first = ManagedRuntime.make(observeLayer({ traceFile }))
    await first.runPromise(stage(1))
    await first.dispose()
    rmSync(traceFile)
    const second = ManagedRuntime.make(observeLayer({ traceFile }))
    await second.runPromise(stage(2))
    await second.dispose()
    const trace: { spans: FinishedSpan[] } = JSON.parse(
      readFileSync(traceFile, 'utf8'),
    )
    expect(trace.spans.map((span) => span.attributes['value'])).toEqual([1, 2])
  })

  test('releases closed exporters as output paths change', async () => {
    const dir = directory()
    let index = 0
    const result = await assertNoLeak(
      async () => {
        const id = index++
        const payload = randomBytes(2_000).toString('hex')
        const runtime = ManagedRuntime.make(
          observeLayer({
            traceFile: join(dir, `trace-${id}.json`),
            metricsFile: join(dir, `metrics-${id}.prom`),
          }),
        )
        await runtime.runPromise(
          Effect.annotateCurrentSpan('payload', payload).pipe(
            Effect.withSpan('tia.test.retention'),
          ),
        )
        await runtime.dispose()
      },
      { iterations: 100, batches: 3, bytesPerOperation: 1_000 },
    )
    expect(result.bytesPerOperation).toBeLessThanOrEqual(1_000)
  }, 30_000)

  test('keeps a bounded number of spans in memory', async () => {
    const finished: FinishedSpan[] = []
    const tracer = recordingTracer(Tracer.nativeTracer, finished)
    const run = () => Effect.runSync(stage(1).pipe(Effect.withTracer(tracer)))
    for (let index = 0; index < TRACE_FILE_SPAN_LIMIT + 50; index += 1) run()
    expect(finished).toHaveLength(TRACE_FILE_SPAN_LIMIT)
    const { bytesPerOperation } = await assertNoLeak(run, {
      bytesPerOperation: 64,
      iterations: 5_000,
    })
    expect(bytesPerOperation).toBeLessThan(64)
  })
})

describe('crash reports', () => {
  test('redacts secret-looking flag values', () => {
    expect(
      redactArguments([
        'plan',
        '--token',
        'abc',
        '--api-key=xyz',
        '--graph',
        'g.json',
      ]),
    ).toEqual([
      'plan',
      '--token',
      '<redacted>',
      '--api-key=<redacted>',
      '--graph',
      'g.json',
    ])
  })

  test('records the cause, versions and redacted arguments', () => {
    const crashes = directory()
    const path = writeCrashReport(Cause.die(new RangeError('boom')), {
      argv: ['verify', '--secret=s3cr3t'],
      directory: crashes,
      now: new Date('2026-10-25T01:02:03.000Z'),
    })
    expect(path).toBeDefined()
    const report = JSON.parse(readFileSync(path ?? '', 'utf8'))
    expect(report).toMatchObject({
      argv: ['verify', '--secret=<redacted>'],
      node: process.version,
      time: '2026-10-25T01:02:03.000Z',
    })
    expect(report.cause).toContain('RangeError: boom')
    expect(JSON.stringify(report)).not.toContain('s3cr3t')
  })

  test('never throws when the report cannot be written', () => {
    expect(
      writeCrashReport(Cause.die('x'), {
        argv: [],
        directory: '\0invalid',
        now: new Date(),
      }),
    ).toBeUndefined()
  })
})
