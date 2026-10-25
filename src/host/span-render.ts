import type { SpanSummary } from './span-book.ts'

export interface RenderOptions {
  /** A closing hint, for example how to send spans here. */
  readonly footer?: string
  /** Shown in the header, for example the address the server listens on. */
  readonly title: string
  /** Lines shown per section. */
  readonly rows?: number
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds >= 60_000) return `${(milliseconds / 60_000).toFixed(1)} min`
  if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(2)} s`
  if (milliseconds >= 10) return `${milliseconds.toFixed(0)} ms`
  return `${milliseconds.toFixed(2)} ms`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ['', title, ...lines]
}

/** One screen of text for the spans and metrics a devtools server received. */
export function renderSummary(
  summary: SpanSummary,
  options: RenderOptions,
): string {
  const rows = options.rows ?? 10
  const failures = summary.failed.length
  const header = [
    options.title,
    `clients ${summary.clients}/${summary.connections}`,
    `spans ${summary.ended} done, ${summary.open} open`,
    `errors ${failures}`,
  ].join('   ')

  const slowest = summary.slowest
    .slice(0, rows)
    .map(
      (span) =>
        `  ${padStart(formatDuration(span.durationMs), 10)}  ${pad(span.name, 34)} #${span.client}${span.status === 'success' ? '' : `  ${span.status}`}`,
    )

  const nameWidth = Math.min(
    40,
    Math.max(4, ...summary.names.slice(0, rows).map((s) => s.name.length)),
  )
  const names = summary.names
    .slice(0, rows)
    .map(
      (stats) =>
        `  ${pad(stats.name, nameWidth)}  ${padStart(String(stats.count), 6)}  ${padStart(formatDuration(stats.totalMs), 10)}  ${padStart(formatDuration(stats.maxMs), 10)}  ${padStart(String(stats.errors), 6)}`,
    )
  const nameTable =
    names.length === 0
      ? []
      : [
          `  ${pad('name', nameWidth)}  ${padStart('count', 6)}  ${padStart('total', 10)}  ${padStart('max', 10)}  ${padStart('errors', 6)}`,
          ...names,
        ]

  const failed = summary.failed
    .slice(0, rows)
    .map(
      (span) =>
        `  ${pad(span.name, 34)} ${padStart(formatDuration(span.durationMs), 10)}  #${span.client}  ${span.message}`,
    )

  const metrics = summary.metrics
    .slice(0, rows)
    .map(
      (metric) =>
        `  ${pad(metric.name, 34)} ${pad(metric.kind.toLowerCase(), 10)} ${metric.value}${metric.attributes === '' ? '' : `  {${metric.attributes}}`}`,
    )
  const hiddenMetrics = summary.metrics.length - metrics.length

  const lines = [
    header,
    ...section('Slowest spans', slowest),
    ...section('Time by span name', nameTable),
    ...section('Failed spans', failed),
    ...section(
      'Metrics',
      hiddenMetrics > 0
        ? [...metrics, `  ... and ${hiddenMetrics} more`]
        : metrics,
    ),
  ]
  if (summary.ended === 0 && summary.metrics.length === 0) {
    lines.push('', 'Waiting for spans.')
  }
  if (options.footer !== undefined) lines.push('', options.footer)
  return `${lines.join('\n')}\n`
}
