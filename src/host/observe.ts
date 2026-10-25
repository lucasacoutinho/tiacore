import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Tracer from 'effect/Tracer'

import { VERSION } from '../core/version.ts'

/**
 * What to export, read once from the environment:
 * - TIACORE_DEVTOOLS: `1` or a WebSocket URL of an Effect devtools server
 *   (default ws://localhost:34437, which `tiacore devtools` and the Effect
 *   editor extensions listen on);
 * - TIACORE_OTLP_URL: base URL of an OTLP/HTTP collector (traces, metrics, logs);
 * - TIACORE_TRACE_FILE: a file that receives every finished span as JSON;
 * - TIACORE_METRICS_FILE: a file that receives all metrics in Prometheus text
 *   format when the process's runtime is disposed.
 */
export interface ObserveConfig {
  readonly devtools?: string
  readonly metricsFile?: string
  readonly otlp?: string
  readonly traceFile?: string
}

const DEFAULT_DEVTOOLS = 'ws://localhost:34437'

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
          devtools: /^(?:1|true|yes|on)$/iu.test(devtools)
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

function writeFile(path: string, body: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  } catch {
    // Observability output must never fail the run it observes.
  }
}

const traceFileLayer = (path: string) =>
  Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* () {
      const finished: FinishedSpan[] = []
      const inner = yield* Effect.tracer
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          writeFile(
            path,
            `${JSON.stringify({ spans: finished, tiacore: VERSION }, null, 2)}\n`,
          ),
        ),
      )
      return recordingTracer(inner, finished)
    }),
  )

/** The observability layer for `config`; empty, and free, when nothing is configured. */
export function observeLayer(config: ObserveConfig): Layer.Layer<never> {
  const layers: Layer.Layer<never>[] = []
  if (config.traceFile !== undefined)
    layers.push(traceFileLayer(config.traceFile))
  if (config.devtools !== undefined) {
    const url = config.devtools
    layers.push(
      Layer.unwrap(
        Effect.promise(() => import('effect/devtools/DevTools')).pipe(
          Effect.map((DevTools) => DevTools.layer(url)),
        ),
      ),
    )
  }
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
        Effect.addFinalizer(() =>
          Effect.promise(
            () => import('effect/observability/PrometheusMetrics'),
          ).pipe(
            Effect.flatMap((PrometheusMetrics) => PrometheusMetrics.format()),
            Effect.map((text) => writeFile(path, text)),
          ),
        ),
      ),
    )
  }
  return layers.reduce<Layer.Layer<never>>(
    (all, layer) => Layer.merge(all, layer),
    Layer.empty,
  )
}
