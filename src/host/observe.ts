import { mkdirSync, writeFileSync } from 'node:fs'
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
 * - TIACORE_TRACE_FILE: a file that receives every finished span as JSON;
 * - TIACORE_METRICS_FILE: a file that receives all metrics in Prometheus text
 *   format.
 * The files are written when the process's runtime is disposed and again when
 * the process exits.
 */
export interface ObserveConfig {
  readonly devtools?: string
  readonly metricsFile?: string
  readonly otlp?: string
  readonly traceFile?: string
}

const DEFAULT_DEVTOOLS = `ws://localhost:${DEFAULT_DEVTOOLS_PORT}`

function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

export function observeConfig(
  env: Readonly<Record<string, string | undefined>>,
): ObserveConfig {
  const devtools = setting(env['TIACORE_DEVTOOLS'])
  const metricsFile = setting(env['TIACORE_METRICS_FILE'])
  const otlp = setting(env['TIACORE_OTLP_URL'])
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
    writeFileSync(path, body())
  } catch {
    // Nothing to do: the run goes on without its output.
  }
}

// A process can build the host runtime several times (it closes when idle), and
// each trace file must hold every span of the process, so the buffers outlive
// the layers. There is one buffer per configured path: one, in practice.
const traceBuffers = new Map<string, FinishedSpan[]>()
let metricsFiles: ReadonlyMap<string, () => string> = new Map()
let exitHookInstalled = false

function writeTraceFile(path: string, spans: readonly FinishedSpan[]): void {
  writeFile(
    path,
    () => `${JSON.stringify({ spans, tiacore: VERSION }, null, 2)}\n`,
  )
}

/** Writes the file exporters' output; runs synchronously when the process exits. */
function flushFiles(): void {
  for (const [path, spans] of traceBuffers) writeTraceFile(path, spans)
  for (const [path, format] of metricsFiles) writeFile(path, format)
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
      let finished = traceBuffers.get(path)
      if (finished === undefined) {
        finished = []
        traceBuffers.set(path, finished)
      }
      installExitHook()
      const spans = finished
      const inner = yield* Effect.tracer
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => writeTraceFile(path, spans)),
      )
      return recordingTracer(inner, spans)
    }),
  )

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
          `tiacore: no devtools server at ${url}; spans are not sent. Start one with \`tiacore devtools\`.\n`,
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
    layers.push(
      Layer.unwrap(
        Effect.promise(() => import('./otlp.ts')).pipe(
          Effect.map((otlp) => otlp.otlpLayer(baseUrl)),
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
            metricsFiles = new Map([...metricsFiles, [path, format]])
            installExitHook()
            return Effect.addFinalizer(() =>
              Effect.sync(() => writeFile(path, format)),
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
