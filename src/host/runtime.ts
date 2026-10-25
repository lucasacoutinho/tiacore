import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Cause from 'effect/Cause'
import type * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'

import { join } from 'node:path'

import type { TiaError } from '../wire/errors.ts'
import { writeCrashReport } from './crash.ts'
import { observeConfig, observeLayer } from './observe.ts'

/** Services every host program may require. */
export type HostServices = NodeServices.NodeServices

let runtime: ManagedRuntime.ManagedRuntime<HostServices, never> | undefined

function host(): ManagedRuntime.ManagedRuntime<HostServices, never> {
  runtime ??= ManagedRuntime.make(
    Layer.merge(NodeServices.layer, observeLayer(observeConfig(process.env))),
  )
  return runtime
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
  const exit = await host().runPromiseExit(program)
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

/** Releases the process-wide runtime; the next run builds a fresh one. */
export async function disposeHost(): Promise<void> {
  const current = runtime
  runtime = undefined
  await current?.dispose()
}
