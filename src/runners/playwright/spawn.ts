import * as Effect from 'effect/Effect'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'

import { TiaIo } from '../../wire/errors.ts'

export interface SpawnOptions {
  readonly arguments: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
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
    extendEnv: false,
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
    Effect.mapError((error) => {
      const cause = error.reason.cause
      return new TiaIo({
        cause: error,
        message: cause instanceof Error ? cause.message : error.reason.message,
      })
    }),
  )
})
