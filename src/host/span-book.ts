import * as Cause from 'effect/Cause'
import type * as DevToolsSchema from 'effect/devtools/DevToolsSchema'
import * as Exit from 'effect/Exit'

/**
 * What `tiacore devtools` knows about the spans and metrics its clients sent.
 * Every collection is bounded, so a server that runs for days holds a fixed
 * amount of memory however many spans arrive.
 */

export const MAX_OPEN_SPANS_PER_CLIENT = 1_000
export const MAX_SPAN_NAMES = 500
export const MAX_METRICS = 1_000
export const SLOWEST_SPANS = 20
export const FAILED_SPANS = 20

/** The name that collects statistics once `MAX_SPAN_NAMES` names exist. */
export const OTHER_SPANS = '(other spans)'

export interface SpanStats {
  readonly count: number
  readonly errors: number
  readonly maxMs: number
  readonly name: string
  readonly totalMs: number
}

export interface SlowSpan {
  readonly client: number
  readonly durationMs: number
  readonly name: string
  readonly status: 'failure' | 'interrupted' | 'success'
}

export interface FailedSpan {
  readonly client: number
  readonly durationMs: number
  readonly message: string
  readonly name: string
}

export interface MetricRow {
  readonly attributes: string
  readonly kind: DevToolsSchema.Metric['type']
  readonly name: string
  readonly value: string
}

export interface SpanSummary {
  readonly clients: number
  readonly connections: number
  readonly ended: number
  readonly failed: readonly FailedSpan[]
  readonly metrics: readonly MetricRow[]
  readonly names: readonly SpanStats[]
  readonly open: number
  readonly slowest: readonly SlowSpan[]
  readonly started: number
}

interface MutableStats {
  count: number
  errors: number
  maxMs: number
  name: string
  totalMs: number
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')
  return (line ?? text).trim().slice(0, 200)
}

function statusOf(exit: Exit.Exit<unknown, unknown>): SlowSpan['status'] {
  if (Exit.isSuccess(exit)) return 'success'
  return Exit.hasInterrupts(exit) ? 'interrupted' : 'failure'
}

function metricValue(metric: DevToolsSchema.Metric): string {
  switch (metric.type) {
    case 'Counter':
      return String(metric.state.count)
    case 'Gauge':
      return String(metric.state.value)
    case 'Frequency':
      return [...metric.state.occurrences]
        .map(([key, count]) => `${key}=${count}`)
        .join(' ')
    case 'Histogram':
    case 'Summary': {
      const { count, max, min, sum } = metric.state
      const mean = count === 0 ? 0 : sum / count
      return `n=${count} mean=${mean.toFixed(2)} min=${min} max=${max}`
    }
  }
}

function attributeText(
  attributes: Readonly<Record<string, string>> | undefined,
): string {
  if (attributes === undefined) return ''
  return Object.entries(attributes)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

export class SpanBook {
  private readonly byName = new Map<string, MutableStats>()
  private readonly clients = new Map<number, Set<string>>()
  private readonly metrics = new Map<string, MetricRow>()
  private failed: FailedSpan[] = []
  private slowest: SlowSpan[] = []
  private connections = 0
  private ended = 0
  private started = 0
  private revision = 0

  /** Grows on every change, so a renderer can skip frames that would repeat. */
  get version(): number {
    return this.revision
  }

  /** Registers a client and returns the number its spans are filed under. */
  connect(): number {
    this.connections += 1
    this.clients.set(this.connections, new Set())
    this.revision += 1
    return this.connections
  }

  /** Forgets the client's spans that never ended; their statistics stay. */
  disconnect(client: number): void {
    this.clients.delete(client)
    this.revision += 1
  }

  ingest(client: number, request: DevToolsSchema.Request.WithoutPing): void {
    this.revision += 1
    switch (request._tag) {
      case 'Span':
        this.ingestSpan(client, request)
        return
      case 'MetricsSnapshot':
        this.ingestMetrics(request)
        return
      case 'SpanEvent':
        return
    }
  }

  summary(): SpanSummary {
    let open = 0
    for (const spans of this.clients.values()) open += spans.size
    return {
      clients: this.clients.size,
      connections: this.connections,
      ended: this.ended,
      failed: this.failed,
      metrics: [...this.metrics.values()].sort(compareMetrics),
      names: [...this.byName.values()].sort(
        (left, right) =>
          right.totalMs - left.totalMs || compareText(left.name, right.name),
      ),
      open,
      slowest: this.slowest,
      started: this.started,
    }
  }

  private ingestSpan(client: number, span: DevToolsSchema.Span): void {
    const open = this.clients.get(client)
    if (span.status._tag === 'Started') {
      this.started += 1
      if (open === undefined) return
      if (open.size >= MAX_OPEN_SPANS_PER_CLIENT) {
        const oldest = open.values().next()
        if (oldest.done !== true) open.delete(oldest.value)
      }
      open.add(span.spanId)
      return
    }
    const { endTime, exit, startTime } = span.status
    const durationMs = Number(endTime - startTime) / 1e6
    const status = statusOf(exit)
    if (open?.delete(span.spanId) !== true) this.started += 1
    this.ended += 1
    this.addStats(span.name, durationMs, status === 'failure')
    this.addSlowest({ client, durationMs, name: span.name, status })
    if (status === 'failure' && Exit.isFailure(exit)) {
      this.failed = [
        {
          client,
          durationMs,
          message: firstLine(Cause.pretty(exit.cause)),
          name: span.name,
        },
        ...this.failed,
      ].slice(0, FAILED_SPANS)
    }
  }

  private addStats(name: string, durationMs: number, failed: boolean): void {
    const key =
      this.byName.has(name) || this.byName.size < MAX_SPAN_NAMES
        ? name
        : OTHER_SPANS
    let stats = this.byName.get(key)
    if (stats === undefined) {
      stats = { count: 0, errors: 0, maxMs: 0, name: key, totalMs: 0 }
      this.byName.set(key, stats)
    }
    stats.count += 1
    stats.totalMs += durationMs
    if (durationMs > stats.maxMs) stats.maxMs = durationMs
    if (failed) stats.errors += 1
  }

  private addSlowest(span: SlowSpan): void {
    const last = this.slowest[this.slowest.length - 1]
    if (
      this.slowest.length >= SLOWEST_SPANS &&
      last !== undefined &&
      span.durationMs <= last.durationMs
    ) {
      return
    }
    const next = [...this.slowest, span].sort(
      (left, right) => right.durationMs - left.durationMs,
    )
    this.slowest = next.slice(0, SLOWEST_SPANS)
  }

  private ingestMetrics(snapshot: DevToolsSchema.MetricsSnapshot): void {
    for (const metric of snapshot.metrics) {
      const attributes = attributeText(metric.attributes)
      const key = `${metric.id}\0${attributes}`
      // Re-inserting moves the metric to the end, so the oldest is evicted.
      this.metrics.delete(key)
      this.metrics.set(key, {
        attributes,
        kind: metric.type,
        name: metric.id,
        value: metricValue(metric),
      })
    }
    while (this.metrics.size > MAX_METRICS) {
      const oldest = this.metrics.keys().next()
      if (oldest.done === true) break
      this.metrics.delete(oldest.value)
    }
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareMetrics(left: MetricRow, right: MetricRow): number {
  return (
    compareText(left.name, right.name) ||
    compareText(left.attributes, right.attributes)
  )
}
