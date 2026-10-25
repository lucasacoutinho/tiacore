import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

export interface ChildSpec {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  /** The complete environment; nothing is inherited beyond it. */
  readonly env: Record<string, string | undefined>
  /** `capture` buffers stdout and stderr together and never forwards them. */
  readonly stdio: 'capture' | 'ignore' | 'inherit'
  /** No limit when omitted. */
  readonly timeoutMs?: number
}

export interface ChildOutcome {
  /** The exit code; null when a signal ended the child or it never started. */
  readonly code: number | null
  /** Combined stdout and stderr for `capture`; the spawn error message otherwise. */
  readonly output: string
  readonly timedOut: boolean
}

// After the leader exits, buffered output may still be in flight; a
// grandchild holding the pipe open must not hold the run hostage.
const DRAIN_GRACE_MS = 1_000

/** A copy of the process environment without `NODE_TEST_CONTEXT`, plus `extra`. */
export function childEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env }
  delete environment['NODE_TEST_CONTEXT']
  return { ...environment, ...extra }
}

/**
 * Spawns one child without a shell and waits for it. The child is killed
 * (SIGKILL) when the timeout fires, the fiber is interrupted or the scope
 * closes. A spawn failure or a timeout is an outcome (`code: null`), never a
 * failure, so one broken file cannot stop the others.
 */
export const runChild = Effect.fnUntraced(function* (spec: ChildSpec) {
  const spawner = yield* ChildProcessSpawner
  const capture = spec.stdio === 'capture'
  const command = ChildProcess.make(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    extendEnv: false,
    killSignal: 'SIGKILL',
    stderr: capture ? 'pipe' : spec.stdio,
    stdin: 'ignore',
    stdout: capture ? 'pipe' : spec.stdio,
  })
  let output = ''
  const decoder = new TextDecoder()
  const attempt = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command)
      const drain = capture
        ? yield* Effect.forkScoped(
            handle.all.pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  output += decoder.decode(chunk, { stream: true })
                }),
              ),
              Effect.ignore,
            ),
          )
        : undefined
      const code = yield* handle.exitCode.pipe(
        Effect.map((exit): number | null => exit),
        Effect.orElseSucceed((): number | null => null),
      )
      if (drain !== undefined) {
        yield* Fiber.join(drain).pipe(Effect.timeoutOption(DRAIN_GRACE_MS))
      }
      return code
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.sync((): number | null => {
        output =
          error.cause instanceof Error ? error.cause.message : error.message
        return null
      }),
    ),
  )
  const result = yield* spec.timeoutMs === undefined
    ? attempt.pipe(Effect.asSome)
    : attempt.pipe(Effect.timeoutOption(spec.timeoutMs))
  const outcome: ChildOutcome = {
    code: Option.getOrElse(result, (): number | null => null),
    output,
    timedOut: Option.isNone(result),
  }
  return outcome
})
