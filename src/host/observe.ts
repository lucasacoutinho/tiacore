import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname } from 'node:path'

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Tracer from 'effect/Tracer'

import { DEFAULT_DEVTOOLS_PORT } from '../core/defaults.ts'
import { envFlag } from '../core/env.ts'
import { VERSION } from '../core/version.ts'

/**
 * What to export, read once from the environment:
 * - TIACORE_DEVTOOLS: `1` or a WebSocket URL of an Effect devtools server
 *   (default ws://localhost:34437, which `tiacore devtools` and the Effect
 *   editor extensions listen on); skipped, with a line on stderr, when nothing
 *   is listening;
 * - TIACORE_OTLP_URL: base URL of an OTLP/HTTP collector (traces, metrics, logs);
 * - TIACORE_OTLP_HEADERS: headers sent with every OTLP request, as
 *   comma-separated `name=value` pairs with percent-encoded values (the
 *   OpenTelemetry format); read only when TIACORE_OTLP_URL is set;
 * - TIACORE_TRACE_FILE: a file that receives every finished span as JSON;
 * - TIACORE_METRICS_FILE: a file that receives all metrics in Prometheus text
 *   format.
 * Active files are written when their runtime is disposed or the process exits.
 */
export interface ObserveConfig {
  readonly devtools?: string
  readonly metricsFile?: string
  readonly otlp?: string
  readonly otlpHeaders?: Readonly<Record<string, string>>
  readonly traceFile?: string
}

const DEFAULT_DEVTOOLS = `ws://localhost:${DEFAULT_DEVTOOLS_PORT}`

function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * The pairs of a `name=value,name=value` header list. A pair with no name, no
 * `=` or a broken percent escape is skipped; undefined when none is left.
 */
function headerList(
  value: string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  let found = false
  for (const pair of value?.split(',') ?? []) {
    const equals = pair.indexOf('=')
    if (equals === -1) continue
    const name = pair.slice(0, equals).trim()
    if (name === '') continue
    try {
      headers[name] = decodeURIComponent(pair.slice(equals + 1).trim())
      found = true
    } catch {
      // A malformed escape cannot be sent as the user meant it.
    }
  }
  return found ? headers : undefined
}

export function observeConfig(
  env: Readonly<Record<string, string | undefined>>,
): ObserveConfig {
  const devtools = setting(env['TIACORE_DEVTOOLS'])
  const metricsFile = setting(env['TIACORE_METRICS_FILE'])
  const otlp = setting(env['TIACORE_OTLP_URL'])
  const otlpHeaders =
    otlp === undefined ? undefined : headerList(env['TIACORE_OTLP_HEADERS'])
  const traceFile = setting(env['TIACORE_TRACE_FILE'])
  return {
    ...(devtools === undefined
      ? {}
      : {
          devtools: envFlag(env, 'TIACORE_DEVTOOLS')
            ? DEFAULT_DEVTOOLS
            : devtools,
        }),
    ...(metricsFile === undefined ? {} : { metricsFile }),
    ...(otlp === undefined ? {} : { otlp }),
    ...(otlpHeaders === undefined ? {} : { otlpHeaders }),
    ...(traceFile === undefined ? {} : { traceFile }),
  }
}

export interface FinishedSpan {
  readonly attributes: Record<string, unknown>
  readonly durationMs: number
  readonly name: string
  readonly parentSpanId: string | null
  readonly spanId: string
  readonly startUnixNanos: string
  readonly status: 'failure' | 'interrupted' | 'success'
  readonly traceId: string
}

/** Most spans a trace file keeps; older spans are dropped first. */
export const TRACE_FILE_SPAN_LIMIT = 10_000

function statusOf(exit: Exit.Exit<unknown, unknown>): FinishedSpan['status'] {
  if (Exit.isSuccess(exit)) return 'success'
  return Exit.hasInterrupts(exit) ? 'interrupted' : 'failure'
}

/** Wraps a tracer so that every span it ends is also kept for a trace file. */
export function recordingTracer(
  inner: Tracer.Tracer,
  finished: FinishedSpan[],
): Tracer.Tracer {
  return Tracer.make({
    ...inner,
    span(options) {
      const span = inner.span(options)
      const end = span.end.bind(span)
      span.end = (endTime, exit) => {
        end(endTime, exit)
        if (finished.length >= TRACE_FILE_SPAN_LIMIT) finished.shift()
        finished.push({
          attributes: Object.fromEntries(span.attributes),
          durationMs: Number(endTime - options.startTime) / 1e6,
          name: span.name,
          parentSpanId: Option.match(span.parent, {
            onNone: () => null,
            onSome: (parent) => parent.spanId,
          }),
          spanId: span.spanId,
          startUnixNanos: options.startTime.toString(),
          status: statusOf(exit),
          traceId: span.traceId,
        })
      }
      return span
    },
  })
}

/** Writes `body()` to `path`. Observability output must never fail the run it observes. */
function writeFile(path: string, body: () => string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const contents = body()
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NONBLOCK,
    )
    try {
      writeFileSync(fd, contents)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Nothing to do: the run goes on without its output.
  }
}

interface TraceBuffer {
  spans: FinishedSpan[] | undefined
  users: number
  readonly ready: Promise<FinishedSpan[]>
}

// Active runtimes share a buffer. Keep only the most recently closed one in
// memory; older paths can recover their history from this process's output.
const traceBuffers = new Map<string, TraceBuffer>()
let recentTrace: { path: string; spans: FinishedSpan[] } | undefined
const metricsFiles = new Set<{ path: string; format: () => string }>()
let exitHookInstalled = false
const processInstance = randomUUID()
let largestTraceBytes = 0

async function readHistory(path: string): Promise<FinishedSpan[]> {
  if (largestTraceBytes === 0) return []
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > largestTraceBytes) return []
    const expected = Buffer.from(
      `{\n  "processInstance": "${processInstance}",\n`,
    )
    const prefix = Buffer.alloc(expected.length)
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0)
    if (bytesRead !== expected.length || !prefix.equals(expected)) return []
    const body = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < body.length) {
      const result = await file.read(body, offset, body.length - offset, offset)
      if (result.bytesRead === 0) return []
      offset += result.bytesRead
    }
    const trace: { processInstance?: string; spans?: FinishedSpan[] } =
      JSON.parse(body.toString())
    return trace.processInstance === processInstance &&
      Array.isArray(trace.spans)
      ? trace.spans.slice(-TRACE_FILE_SPAN_LIMIT)
      : []
  } catch {
    return []
  } finally {
    await file?.close().catch(() => {})
  }
}

function acquireTrace(path: string): TraceBuffer {
  let buffer = traceBuffers.get(path)
  if (buffer === undefined) {
    const recent = recentTrace?.path === path ? recentTrace.spans : undefined
    if (recent !== undefined) recentTrace = undefined
    buffer = {
      spans: recent,
      users: 0,
      ready: recent === undefined ? readHistory(path) : Promise.resolve(recent),
    }
    traceBuffers.set(path, buffer)
  }
  buffer.users += 1
  return buffer
}

function writeTraceFile(path: string, spans: readonly FinishedSpan[]): void {
  writeFile(path, () => {
    const body = `${JSON.stringify({ processInstance, spans, tiacore: VERSION }, null, 2)}\n`
    largestTraceBytes = Math.max(largestTraceBytes, Buffer.byteLength(body))
    return body
  })
}

/** Writes the file exporters' output; runs synchronously when the process exits. */
function flushFiles(): void {
  for (const [path, buffer] of traceBuffers) {
    if (buffer.spans !== undefined) writeTraceFile(path, buffer.spans)
  }
  for (const { path, format } of metricsFiles) writeFile(path, format)
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', flushFiles)
}

const traceFileLayer = (path: string) =>
  Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* () {
      const { spans: finished } = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const buffer = acquireTrace(path)
          installExitHook()
          const history = await buffer.ready
          buffer.spans = history
          return { buffer, spans: history }
        }),
        ({ buffer, spans }) =>
          Effect.sync(() => {
            writeTraceFile(path, spans)
            buffer.users -= 1
            if (buffer.users === 0) {
              traceBuffers.delete(path)
              recentTrace = { path, spans }
            }
          }),
      )
      return recordingTracer(yield* Effect.tracer, finished)
    }),
  )

/**
 * `url` with its user name and password replaced, for output a person may
 * share. Anything else in the text stays as it was written.
 */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/iu, '$1<redacted>@')
}

/** Whether something accepts connections at the host and port of a WebSocket URL. */
export function serverReachable(
  url: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      resolve(false)
      return
    }
    const socket = connect({
      host: target.hostname.replace(/^\[|\]$/gu, ''),
      port: Number(target.port) || (target.protocol === 'wss:' ? 443 : 80),
    })
    const done = (reachable: boolean) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Effect's devtools client keeps every span in memory until a server takes
 * it, so a run with nobody listening must not start it at all.
 */
const devtoolsLayer = (url: string): Layer.Layer<never> =>
  Layer.unwrap(
    Effect.promise(async () => {
      if (!(await serverReachable(url))) {
        process.stderr.write(
          `tiacore: no devtools server at ${redactUrl(url)}; spans are not sent. Start one with \`tiacore devtools\`.\n`,
        )
        return Layer.empty
      }
      const DevTools = await import('effect/devtools/DevTools')
      return DevTools.layer(url)
    }),
  )

/** The observability layer for `config`; empty, and free, when nothing is configured. */
export function observeLayer(config: ObserveConfig): Layer.Layer<never> {
  const layers: Layer.Layer<never>[] = []
  if (config.traceFile !== undefined)
    layers.push(traceFileLayer(config.traceFile))
  if (config.devtools !== undefined) layers.push(devtoolsLayer(config.devtools))
  if (config.otlp !== undefined) {
    const baseUrl = config.otlp
    const headers = config.otlpHeaders ?? {}
    layers.push(
      Layer.unwrap(
        Effect.promise(() => import('./otlp.ts')).pipe(
          Effect.map((otlp) => otlp.otlpLayer(baseUrl, headers)),
        ),
      ),
    )
  }
  if (config.metricsFile !== undefined) {
    const path = config.metricsFile
    layers.push(
      Layer.effectDiscard(
        Effect.promise(
          () => import('effect/observability/PrometheusMetrics'),
        ).pipe(
          Effect.flatMap((PrometheusMetrics) => {
            const format = () => PrometheusMetrics.formatUnsafe(Context.empty())
            const registration = { path, format }
            metricsFiles.add(registration)
            installExitHook()
            return Effect.addFinalizer(() =>
              Effect.sync(() => {
                writeFile(path, format)
                metricsFiles.delete(registration)
              }),
            )
          }),
        ),
      ),
    )
  }
  return layers.reduce<Layer.Layer<never>>(
    (all, layer) => Layer.merge(all, layer),
    Layer.empty,
  )
}
