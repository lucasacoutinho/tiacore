import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import {
  errorMessage,
  systemIoError,
  TiaFailed,
  TiaInvalid,
} from '../wire/errors.ts'

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

/**
 * Writes `value` as pretty JSON to stdout (no path or `-`) or to a file,
 * creating the file's directory first.
 */
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
    .makeDirectory(dirname(output), { recursive: true })
    .pipe(Effect.mapError(systemIoError))
  yield* fs
    .writeFileString(output, serialized)
    .pipe(Effect.mapError(systemIoError))
})

/**
 * Fails after a receipt reported the failure, so the CLI exits 1 without a
 * message, as 1.x did. A receipt written to a file leaves the terminal
 * empty, so then one line on stderr says what failed and where to look.
 */
export const failedReceipt = Effect.fnUntraced(function* (
  message: string,
  output: string | undefined,
) {
  if (output !== undefined && output !== '-') {
    yield* Effect.sync(() =>
      process.stderr.write(`${message}; see ${output}\n`),
    )
  }
  return yield* new TiaFailed({ message, silent: true })
})

/** Runs a 1.x-style throwing computation, keeping its message as TiaInvalid. */
export function attempt<A>(compute: () => A): Effect.Effect<A, TiaInvalid> {
  return Effect.try({
    catch: (error) => new TiaInvalid({ message: errorMessage(error) }),
    try: compute,
  })
}
