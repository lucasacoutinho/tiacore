import { availableParallelism } from 'node:os'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'

import { byCodeUnit } from '../core/canonical.ts'
import type { AdapterExecution } from '../core/execution.ts'
import type { TiaSuiteDescriptor } from '../core/protocol.ts'
import { TiaInvalid, type TiaIo } from '../wire/errors.ts'
import { inheritedEnvironment, runAttached } from './process.ts'

/**
 * The bounded worker count for a run: `min(4, available parallelism)` when
 * unset, otherwise the floor of the value, at least 1. NaN and infinities are
 * rejected at the public seam: NaN would start zero workers and drop the work,
 * and an infinite count would start every file at once.
 */
export function normalizedConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return Math.max(1, Math.min(4, availableParallelism()))
  }
  if (!Number.isFinite(value)) {
    throw new Error('TIA concurrency must be a finite number')
  }
  return Math.max(1, Math.floor(value))
}

const Concurrency = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const decodeConcurrency = Schema.decodeUnknownEffect(Concurrency)

export interface ExecuteSuitesOptions<Suite extends TiaSuiteDescriptor> {
  argumentsFor(suite: Suite): string[]
  command: string
  cwd: string
  environment?: NodeJS.ProcessEnv | undefined
  maxConcurrency: number
  suites: Suite[]
}

/**
 * Runs the suites as child processes, at most `maxConcurrency` at once and
 * never two whose resource locks intersect. A suite launches as soon as a slot
 * and all its locks are free, so a later free suite may overtake a blocked
 * one. Every suite runs even after another fails; executions come back sorted
 * by suite id. A spawn failure fails the run and stops the running children.
 */
export const executeSuites = Effect.fn('tia.scheduling.execute')(function* <
  Suite extends TiaSuiteDescriptor,
>(options: ExecuteSuitesOptions<Suite>) {
  yield* decodeConcurrency(options.maxConcurrency).pipe(
    Effect.mapError(
      () =>
        new TiaInvalid({
          message: 'TIA adapter maxConcurrency must be a positive integer',
        }),
    ),
  )
  const pending = [...options.suites]
  const activeLocks = new Set<string>()
  const executions: AdapterExecution[] = []
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const finished =
        yield* Queue.unbounded<readonly [Suite, Exit.Exit<number, TiaIo>]>()
      let running = 0
      while (pending.length > 0 || running > 0) {
        while (running < options.maxConcurrency) {
          const index = pending.findIndex((suite) =>
            (suite.resourceLocks ?? []).every((lock) => !activeLocks.has(lock)),
          )
          const suite = index < 0 ? undefined : pending.splice(index, 1)[0]
          if (suite === undefined) break
          for (const lock of suite.resourceLocks ?? []) activeLocks.add(lock)
          running += 1
          yield* Effect.forkScoped(
            runAttached({
              args: options.argumentsFor(suite),
              command: options.command,
              cwd: options.cwd,
              env: inheritedEnvironment(options.environment),
            }).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Queue.offer(finished, [suite, exit])),
            ),
          )
        }
        const [suite, exit] = yield* Queue.take(finished)
        running -= 1
        for (const lock of suite.resourceLocks ?? []) activeLocks.delete(lock)
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
        executions.push({ status: exit.value, suiteId: suite.id })
      }
      return executions.sort((left, right) =>
        byCodeUnit(left.suiteId, right.suiteId),
      )
    }),
  )
})

/** The aggregate status of a run: the first non-zero status by suite id. */
export function aggregateStatus(
  executions: readonly AdapterExecution[],
): number {
  return executions.find((execution) => execution.status !== 0)?.status ?? 0
}
