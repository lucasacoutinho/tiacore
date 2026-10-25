import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { errorMessage, systemIoError, TiaInvalid } from '../wire/errors.ts'

export const readText = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(Effect.mapError(systemIoError))
})

export const readJson = Effect.fnUntraced(function* (path: string) {
  const text = yield* readText(path)
  return yield* Effect.try({
    catch: (error) => new TiaInvalid({ message: errorMessage(error) }),
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
    .pipe(Effect.mapError(systemIoError))
})

/** Runs a 1.x-style throwing computation, keeping its message as TiaInvalid. */
export function attempt<A>(compute: () => A): Effect.Effect<A, TiaInvalid> {
  return Effect.try({
    catch: (error) => new TiaInvalid({ message: errorMessage(error) }),
    try: compute,
  })
}
