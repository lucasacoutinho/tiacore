import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'

import { TiaInvalid, TiaIo } from '../wire/errors.ts'

/** The message Node gave the failure, which 1.x printed verbatim. */
function ioMessage(error: PlatformError.PlatformError): string {
  return error.cause instanceof Error ? error.cause.message : error.message
}

export const readText = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (error) => new TiaIo({ cause: error, message: ioMessage(error) }),
      ),
    )
})

export const readJson = Effect.fnUntraced(function* (path: string) {
  const text = yield* readText(path)
  return yield* Effect.try({
    catch: (error) =>
      new TiaInvalid({
        message: error instanceof Error ? error.message : String(error),
      }),
    try: (): unknown => JSON.parse(text),
  })
})

/** Writes `value` as pretty JSON to stdout (no path or `-`) or to a file. */
export const emitJson = Effect.fnUntraced(function* (
  value: unknown,
  output: string | undefined,
) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (output === undefined || output === '-') {
    yield* Effect.sync(() => process.stdout.write(serialized))
    return
  }
  const fs = yield* FileSystem.FileSystem
  yield* fs
    .writeFileString(output, serialized)
    .pipe(
      Effect.mapError(
        (error) => new TiaIo({ cause: error, message: ioMessage(error) }),
      ),
    )
})

/** Runs a 1.x-style throwing computation, keeping its message as TiaInvalid. */
export function attempt<A>(compute: () => A): Effect.Effect<A, TiaInvalid> {
  return Effect.try({
    catch: (error) =>
      new TiaInvalid({
        message: error instanceof Error ? error.message : String(error),
      }),
    try: compute,
  })
}
