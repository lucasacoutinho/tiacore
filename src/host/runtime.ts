import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'

import { join } from 'node:path'

import type { TiaError } from '../wire/errors.ts'
import { writeCrashReport } from './crash.ts'
import { recordRun } from './metrics.ts'
import {
  type FinishedSpan,
  observeConfig,
  observeLayer,
  recordingTracer,
} from './observe.ts'

/** Services every host program may require. */
export type HostServices = NodeServices.NodeServices

/**
 * How long a runtime that holds exporters may sit idle before it closes. A
 * devtools socket or an OTLP timer would otherwise keep the process alive after
 * its last run, and nothing else would flush what they buffer.
 */
export const IDLE_DISPOSE_MS = 500

let runtime: ManagedRuntime.ManagedRuntime<HostServices, never> | undefined
let recorded: FinishedSpan[] | undefined
let exporting = false
let running = 0
let idle: NodeJS.Timeout | undefined

function host(): ManagedRuntime.ManagedRuntime<HostServices, never> {
  if (runtime === undefined) {
    const config = observeConfig(process.env)
    exporting = Object.keys(config).length > 0
    runtime = ManagedRuntime.make(
      Layer.merge(NodeServices.layer, observeLayer(config)),
    )
  }
  return runtime
}

/** Whether the runtime carries an exporter; builds the runtime if it does not exist yet. */
function isExporting(): boolean {
  host()
  return exporting
}

/** Runs `program` on the runtime and closes the runtime after a quiet spell if it exports. */
async function execute<A>(
  program: Effect.Effect<A, TiaError, HostServices>,
): Promise<Exit.Exit<A, TiaError>> {
  clearTimeout(idle)
  running += 1
  try {
    return await host().runPromiseExit(program)
  } finally {
    running -= 1
    if (running === 0 && exporting) {
      // Unreferenced: if the exporters were all that kept the process alive
      // the timer still fires, and if not the process may simply end.
      idle = setTimeout(() => {
        disposeHost().catch(() => undefined)
      }, IDLE_DISPOSE_MS)
      idle.unref()
    }
  }
}

/**
 * Runs a tiacore program at a public seam. A tagged failure becomes an Error
 * with the failure's message and the tagged error as its cause; defects are
 * rethrown unchanged after a crash report is written (TIACORE_CRASH_DIR,
 * default .tia/crashes). The process-wide runtime holds stateless Node
 * services and the exporters `observeConfig` enables, so per-run resources
 * must live in the program's own Scope.
 */
export async function runPromise<A>(
  program: Effect.Effect<A, TiaError, HostServices>,
): Promise<A> {
  const sink = recorded
  // Metrics only reach an exporter, so a process without one does not collect them.
  const measured = isExporting()
    ? Effect.suspend(() => {
        const started = performance.now()
        return program.pipe(
          Effect.onExit((exit) => recordRun(exit, performance.now() - started)),
        )
      })
    : program
  const exit = await execute(
    sink === undefined
      ? measured
      : Effect.flatMap(Effect.tracer, (inner) =>
          Effect.withTracer(measured, recordingTracer(inner, sink)),
        ),
  )
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) {
    throw new Error(failure.value.message, { cause: failure.value })
  }
  const report = writeCrashReport(exit.cause, {
    argv: process.argv.slice(2),
    directory:
      process.env['TIACORE_CRASH_DIR'] ??
      join(process.cwd(), '.tia', 'crashes'),
    now: new Date(),
  })
  if (report !== undefined) {
    process.stderr.write(`TIA crash report written to ${report}\n`)
  }
  throw Cause.squash(exit.cause)
}

/**
 * Runs `body` and returns the spans every `runPromise` call inside it
 * finished, next to its result. `tiacore doctor --perf` uses it to time the
 * real engine stages. Calls must not overlap.
 */
export async function recordSpans<A>(
  body: () => Promise<A>,
): Promise<{ readonly result: A; readonly spans: readonly FinishedSpan[] }> {
  const spans: FinishedSpan[] = []
  const previous = recorded
  recorded = spans
  try {
    return { result: await body(), spans }
  } finally {
    recorded = previous
  }
}

/** Releases the process-wide runtime; the next run builds a fresh one. */
export async function disposeHost(): Promise<void> {
  clearTimeout(idle)
  const current = runtime
  runtime = undefined
  await current?.dispose()
}
