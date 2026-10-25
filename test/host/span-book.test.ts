import * as Cause from 'effect/Cause'
import type * as DevToolsSchema from 'effect/devtools/DevToolsSchema'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import { describe, expect, test } from 'vitest'

import {
  FAILED_SPANS,
  MAX_METRICS,
  MAX_OPEN_SPANS_PER_CLIENT,
  MAX_SPAN_NAMES,
  OTHER_SPANS,
  SLOWEST_SPANS,
  SpanBook,
} from '../../src/host/span-book.ts'
import { TiaIo } from '../../src/wire/errors.ts'
import { formatDuration, renderSummary } from '../../src/host/span-render.ts'
import { assertNoLeak } from '../support/leak.ts'

const MS = 1_000_000n

function started(spanId: string, name = 'tia.test'): DevToolsSchema.Span {
  return {
    _tag: 'Span',
    attributes: new Map(),
    name,
    parent: Option.none(),
    sampled: true,
    spanId,
    status: { _tag: 'Started', startTime: 0n },
    traceId: 't',
  }
}

function ended(
  spanId: string,
  name: string,
  durationMs: number,
  exit: Exit.Exit<unknown, unknown> = Exit.void,
): DevToolsSchema.Span {
  return {
    ...started(spanId, name),
    status: {
      _tag: 'Ended',
      endTime: BigInt(durationMs) * MS,
      exit,
      startTime: 0n,
    },
  }
}

const snapshot = (count: number): DevToolsSchema.MetricsSnapshot => ({
  _tag: 'MetricsSnapshot',
  metrics: [
    {
      attributes: { outcome: 'success' },
      description: undefined,
      id: 'tia_runs_total',
      state: { count, incremental: true },
      type: 'Counter',
    },
    {
      attributes: undefined,
      description: undefined,
      id: 'tia_run_duration_ms',
      state: { buckets: [], count: 2, max: 9, min: 1, sum: 10 },
      type: 'Histogram',
    },
  ],
})

describe('SpanBook', () => {
  test('pairs a started span with its end and totals by name', () => {
    const book = new SpanBook()
    const client = book.connect()
    book.ingest(client, started('a', 'tia.prepare'))
    expect(book.summary()).toMatchObject({ clients: 1, open: 1, started: 1 })
    book.ingest(client, ended('a', 'tia.prepare', 30))
    book.ingest(client, ended('b', 'tia.prepare', 10))
    const summary = book.summary()
    expect(summary).toMatchObject({ ended: 2, open: 0 })
    expect(summary.names).toEqual([
      { count: 2, errors: 0, maxMs: 30, name: 'tia.prepare', totalMs: 40 },
    ])
    expect(summary.slowest.map((span) => span.durationMs)).toEqual([30, 10])
  })

  test('keeps failures with the first line of their cause', () => {
    const book = new SpanBook()
    const client = book.connect()
    book.ingest(
      client,
      ended(
        'a',
        'tia.commit',
        5,
        Exit.fail(new TiaIo({ message: 'store is locked' })),
      ),
    )
    book.ingest(client, ended('b', 'tia.commit', 7, Exit.interrupt(1)))
    const summary = book.summary()
    expect(summary.failed).toHaveLength(1)
    expect(summary.failed[0]).toMatchObject({ name: 'tia.commit' })
    expect(summary.failed[0]?.message).toContain('store is locked')
    // An interrupt is not an error.
    expect(summary.names[0]).toMatchObject({ count: 2, errors: 1 })
    expect(summary.slowest.map((span) => span.status)).toEqual([
      'interrupted',
      'failure',
    ])
  })

  test('forgets a client’s open spans when it disconnects', () => {
    const book = new SpanBook()
    const first = book.connect()
    const second = book.connect()
    book.ingest(first, started('a'))
    book.ingest(second, started('b'))
    book.disconnect(first)
    expect(book.summary()).toMatchObject({
      clients: 1,
      connections: 2,
      open: 1,
    })
  })

  test('keeps the latest value of each metric', () => {
    const book = new SpanBook()
    const client = book.connect()
    book.ingest(client, snapshot(1))
    book.ingest(client, snapshot(4))
    expect(book.summary().metrics).toEqual([
      {
        attributes: '',
        kind: 'Histogram',
        name: 'tia_run_duration_ms',
        value: 'n=2 mean=5.00 min=1 max=9',
      },
      {
        attributes: 'outcome=success',
        kind: 'Counter',
        name: 'tia_runs_total',
        value: '4',
      },
    ])
  })

  test('stays within its bounds however many spans arrive', () => {
    const book = new SpanBook()
    const client = book.connect()
    for (let index = 0; index < MAX_OPEN_SPANS_PER_CLIENT + 50; index += 1) {
      book.ingest(client, started(`open-${index}`))
    }
    expect(book.summary().open).toBe(MAX_OPEN_SPANS_PER_CLIENT)
    for (let index = 0; index < MAX_SPAN_NAMES + 50; index += 1) {
      book.ingest(client, ended(`n-${index}`, `name-${index}`, index % 90))
      book.ingest(
        client,
        ended(
          `e-${index}`,
          'tia.failing',
          1,
          Exit.fail(new TiaIo({ message: 'x' })),
        ),
      )
    }
    const summary = book.summary()
    expect(summary.names).toHaveLength(MAX_SPAN_NAMES + 1)
    expect(summary.names.some((stats) => stats.name === OTHER_SPANS)).toBe(true)
    expect(summary.slowest).toHaveLength(SLOWEST_SPANS)
    expect(summary.failed).toHaveLength(FAILED_SPANS)
    const metrics: DevToolsSchema.MetricsSnapshot = {
      _tag: 'MetricsSnapshot',
      metrics: Array.from({ length: MAX_METRICS + 20 }, (_, index) => ({
        attributes: undefined,
        description: undefined,
        id: `metric-${index}`,
        state: { value: index },
        type: 'Gauge' as const,
      })),
    }
    book.ingest(client, metrics)
    expect(book.summary().metrics).toHaveLength(MAX_METRICS)
  })

  test('retains nothing per span once the bounds are full', async () => {
    const book = new SpanBook()
    const client = book.connect()
    let tick = 0
    const result = await assertNoLeak(
      () => {
        tick += 1
        book.ingest(client, started(`s-${tick}`, `name-${tick % 700}`))
        book.ingest(client, ended(`s-${tick}`, `name-${tick % 700}`, tick % 50))
        book.summary()
      },
      { bytesPerOperation: 64, iterations: 5_000 },
    )
    expect(result.bytesPerOperation).toBeLessThan(64)
  })
})

describe('renderSummary', () => {
  test('lists slowest spans, totals, failures and metrics', () => {
    const book = new SpanBook()
    const client = book.connect()
    book.ingest(client, ended('a', 'tia.prepare', 1_500))
    book.ingest(client, ended('b', 'tia.commit', 12))
    book.ingest(
      client,
      ended(
        'c',
        'tia.commit',
        3,
        Exit.failCause(Cause.die(new RangeError('boom'))),
      ),
    )
    const text = renderSummary(book.summary(), {
      footer: 'Press Ctrl-C to stop.',
      title: 'tiacore devtools ws://localhost:1',
    })
    expect(text).toContain('Slowest spans')
    expect(text).toContain('1.50 s  tia.prepare')
    expect(text).toContain('Time by span name')
    expect(text).toContain('Failed spans')
    expect(text).toContain('boom')
    expect(text).toContain('errors 1')
    expect(text.endsWith('Press Ctrl-C to stop.\n')).toBe(true)
  })

  test('says it is waiting when nothing has arrived', () => {
    const text = renderSummary(new SpanBook().summary(), { title: 'devtools' })
    expect(text).toContain('Waiting for spans.')
  })

  test('formats durations at every scale', () => {
    expect(formatDuration(0.5)).toBe('0.50 ms')
    expect(formatDuration(12.4)).toBe('12 ms')
    expect(formatDuration(1_500)).toBe('1.50 s')
    expect(formatDuration(90_000)).toBe('1.5 min')
  })
})
