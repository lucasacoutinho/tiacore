import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
