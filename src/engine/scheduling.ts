import { availableParallelism } from 'node:os'
import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'

import { byCodeUnit } from '../core/canonical.ts'
import type { AdapterExecution } from '../core/execution.ts'
import type { TiaImpactGraph, TiaSuiteDescriptor } from '../core/protocol.ts'
import { parseImpactGraph } from '../wire/decode.ts'
import { TiaInvalid, TiaIo } from '../wire/errors.ts'

/** The worker count for a run: the machine default capped at 4, or the caller's. */
export function normalizedConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return Math.max(1, Math.min(4, availableParallelism()))
  }
  if (!Number.isFinite(value)) {
    throw new Error('TIA concurrency must be a finite number')
  }
  return Math.max(1, Math.floor(value))
}

export function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const value of values) {
    const group = key(value)
    const items = groups.get(group)
    if (items === undefined) groups.set(group, [value])
    else items.push(value)
  }
  return groups
}

/** Maps with at most `concurrency` workers; results keep the input order. */
export async function parallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array<R>(values.length)
  const entries = values.entries()
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (const [index, value] of entries) {
        results[index] = await worker(value, index)
      }
    }),
  )
  return results
}

const Concurrency = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const decodeConcurrency = Schema.decodeUnknownEffect(Concurrency)

/** Node's own message for an I/O failure, which 1.x printed verbatim. */
export function systemMessage(error: {
  readonly cause?: unknown
  readonly message: string
}): string {
  return error.cause instanceof Error ? error.cause.message : error.message
}

export interface SpawnOptions {
  readonly arguments: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly environment?: NodeJS.ProcessEnv | undefined
}

/**
 * Runs one command with the parent's stdio and resolves with its status: the
 * exit code, or 128 when a signal ended it. A spawn failure is a TiaIo.
 */
export const spawnStatus = Effect.fnUntraced(function* (options: SpawnOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(options.command, [...options.arguments], {
    cwd: options.cwd,
    detached: false,
    env: { ...options.environment },
    extendEnv: true,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command)
      return yield* handle.exitCode.pipe(
        Effect.map((code): number => code),
        Effect.catchIf(
          (error) => error.reason.method === 'exitCode',
          () => Effect.succeed(128),
        ),
      )
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new TiaIo({ cause: error, message: systemMessage(error.reason) }),
    ),
  )
})

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
            spawnStatus({
              arguments: options.argumentsFor(suite),
              command: options.command,
              cwd: options.cwd,
              environment: options.environment,
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

/** Reads a recorded graph; a missing, unreadable or invalid file is no graph. */
export const readAdapterGraph = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.map((text): TiaImpactGraph | null => {
      try {
        return parseImpactGraph(JSON.parse(text))
      } catch {
        return null
      }
    }),
    Effect.orElseSucceed((): TiaImpactGraph | null => null),
  )
})

/** Promotes a graph atomically: write a temporary file, then rename it. */
export const writeAdapterGraph = Effect.fnUntraced(function* (
  path: string,
  graph: TiaImpactGraph,
) {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${path}.${process.pid}.tmp`
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(path), { recursive: true })
    yield* fs.writeFileString(temporary, `${JSON.stringify(graph, null, 2)}\n`)
    yield* fs.rename(temporary, path)
  }).pipe(
    Effect.tapError(() => Effect.ignore(fs.remove(temporary, { force: true }))),
    Effect.mapError(
      (error) => new TiaIo({ cause: error, message: systemMessage(error) }),
    ),
  )
})
