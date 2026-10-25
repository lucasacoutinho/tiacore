import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { TiaIo } from '../wire/errors.ts'

/** What a caller says about the child it wants run. */
export interface ProcessSpec {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  /**
   * The complete environment of the child. Nothing is inherited beyond it, and
   * a variable whose value is `undefined` is left out. Build it with
   * `inheritedEnvironment`.
   */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Which process group the child runs in.
   *
   * - `own` (default): a group of its own. The whole group gets `SIGKILL` when
   *   the run times out, overflows, is interrupted, or the leader exits, so no
   *   grandchild outlives it. A terminal's Ctrl-C does not reach the child.
   * - `shared`: our group, so a terminal's Ctrl-C reaches the child. Only the
   *   leader is stopped, with `SIGTERM`, when the run is interrupted, and a
   *   grandchild that outlives it is left alone.
   */
  readonly group?: 'own' | 'shared'
  /** Stop and kill the process once stdout and stderr together exceed this. */
  readonly maxOutputBytes?: number
  /**
   * What happens to the child's streams.
   *
   * - `capture`: stdin closed; stdout and stderr are collected together into
   *   `output` and never forwarded.
   * - `discard`: all three streams closed.
   * - `forward`: stdin closed; stdout and stderr go to ours.
   * - `terminal`: all three streams are ours, so the child can read the
   *   terminal.
   */
  readonly stdio: 'capture' | 'discard' | 'forward' | 'terminal'
  /** No limit when omitted. */
  readonly timeoutMs?: number
}

/** What happened to a child that started. A non-zero exit is an outcome. */
export interface ProcessOutcome {
  /** The exit code; null when a signal or the timeout ended the process. */
  readonly code: number | null
  /** Combined stdout and stderr for `capture`; empty otherwise. */
  readonly output: string
  readonly overflowed: boolean
  /** The shell's view of the end: `code`, or 128 when there is none. */
  readonly status: number
  readonly timedOut: boolean
}

// After the leader exits, buffered output may still be in flight; a
// grandchild holding the pipe open must not hold the run hostage.
const DRAIN_GRACE_MS = 1_000

const STREAMS = {
  capture: { stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
  discard: { stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' },
  forward: { stderr: 'inherit', stdin: 'ignore', stdout: 'inherit' },
  terminal: { stderr: 'inherit', stdin: 'inherit', stdout: 'inherit' },
} as const

/** Our environment with `overlay` applied; an `undefined` value removes the variable. */
export function inheritedEnvironment(
  overlay: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return { ...process.env, ...overlay }
}

/** Node's own message for an I/O failure, which 1.x printed verbatim. */
export function systemMessage(error: {
  readonly cause?: unknown
  readonly message: string
}): string {
  return error.cause instanceof Error ? error.cause.message : error.message
}

/**
 * Spawns one process without a shell and waits for it. A spawn failure
 * (missing command or directory) is a TiaIo failure; a non-zero exit, a
 * signal, a timeout and an output overflow are outcomes. The child is stopped
 * as `ProcessSpec.group` says when the fiber is interrupted or the scope
 * closes.
 */
export const runProcess = Effect.fnUntraced(function* (spec: ProcessSpec) {
  const spawner = yield* ChildProcessSpawner
  const shared = spec.group === 'shared'
  const killSignal = shared ? 'SIGTERM' : 'SIGKILL'
  const capture = spec.stdio === 'capture'
  const command = ChildProcess.make(spec.command, [...spec.args], {
    cwd: spec.cwd,
    ...(shared ? { detached: false } : {}),
    env: { ...spec.env },
    extendEnv: false,
    killSignal,
    ...STREAMS[spec.stdio],
  })
  const limit = spec.maxOutputBytes ?? Number.POSITIVE_INFINITY
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ''
  let overflowed = false
  const attempt = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command)
      const drain = capture
        ? yield* Effect.forkScoped(
            handle.all.pipe(
              Stream.runForEach((chunk) =>
                Effect.suspend(() => {
                  if (overflowed) return Effect.void
                  bytes += chunk.byteLength
                  if (bytes > limit) {
                    overflowed = true
                    return Effect.ignore(handle.kill({ killSignal }))
                  }
                  output += decoder.decode(chunk, { stream: true })
                  return Effect.void
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
    Effect.mapError(
      (error) => new TiaIo({ cause: error, message: systemMessage(error) }),
    ),
  )
  const result = yield* spec.timeoutMs === undefined
    ? attempt.pipe(Effect.asSome)
    : attempt.pipe(Effect.timeoutOption(spec.timeoutMs))
  const code = Option.getOrElse(result, (): number | null => null)
  const outcome: ProcessOutcome = {
    code,
    output,
    overflowed,
    status: code ?? 128,
    timedOut: Option.isNone(result),
  }
  return outcome
})

/**
 * Runs a command attached to our terminal and returns its status. The child
 * shares our stdio and process group, so a terminal's Ctrl-C reaches it.
 */
export const runAttached = (spec: Omit<ProcessSpec, 'group' | 'stdio'>) =>
  runProcess({ ...spec, group: 'shared', stdio: 'terminal' }).pipe(
    Effect.map((outcome) => outcome.status),
  )
