import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { TiaIo } from '../wire/errors.ts'

export interface ProcessSpec {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string | undefined> | undefined
  /** Stop and fail the run once stdout and stderr together exceed this. */
  readonly maxOutputBytes?: number
  /** `inherit` forwards the child's stdio to ours; `capture` counts output. */
  readonly stdio: 'capture' | 'inherit'
  readonly timeoutMs?: number
}

export interface ProcessOutcome {
  /** The exit code, or null when a signal ended the process. */
  readonly code: number | null
  readonly overflowed: boolean
  readonly timedOut: boolean
}

// After the leader exits, buffered output may still be in flight; a
// grandchild holding the pipe open must not hold the run hostage.
const DRAIN_GRACE_MS = 1_000

/**
 * Spawns one process without a shell. The process group is killed (SIGKILL)
 * when the run times out, overflows, is interrupted or its scope closes.
 * A spawn failure (missing command or directory) is a TiaIo failure; a
 * non-zero exit or a signal is an outcome, not a failure.
 */
export const runProcess = Effect.fnUntraced(function* (spec: ProcessSpec) {
  const spawner = yield* ChildProcessSpawner
  const capture = spec.stdio === 'capture'
  const command = ChildProcess.make(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    extendEnv: true,
    killSignal: 'SIGKILL',
    stderr: capture ? 'pipe' : 'inherit',
    stdin: capture ? 'ignore' : 'inherit',
    stdout: capture ? 'pipe' : 'inherit',
  })
  let bytes = 0
  const limit = spec.maxOutputBytes ?? Number.POSITIVE_INFINITY
  const attempt = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command)
      const drain = yield* Effect.forkScoped(
        handle.all.pipe(
          Stream.runForEach((chunk) => {
            bytes += chunk.byteLength
            return bytes > limit
              ? Effect.ignore(handle.kill({ killSignal: 'SIGKILL' }))
              : Effect.void
          }),
          Effect.ignore,
        ),
      )
      const code = yield* handle.exitCode.pipe(
        Effect.map((exit): number | null => exit),
        Effect.orElseSucceed((): number | null => null),
      )
      yield* Fiber.join(drain).pipe(Effect.timeoutOption(DRAIN_GRACE_MS))
      return code
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new TiaIo({
          cause: error,
          message:
            error.cause instanceof Error ? error.cause.message : error.message,
        }),
    ),
  )
  const bounded =
    spec.timeoutMs === undefined
      ? attempt.pipe(Effect.asSome)
      : attempt.pipe(Effect.timeoutOption(spec.timeoutMs))
  const result = yield* bounded
  const outcome: ProcessOutcome = {
    code: Option.getOrElse(result, (): number | null => null),
    overflowed: bytes > limit,
    timedOut: Option.isNone(result),
  }
  return outcome
})
