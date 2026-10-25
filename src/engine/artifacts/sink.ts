import { randomUUID } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import {
  isSafeRelativePath,
  type TiaArtifactSink,
  type TiaArtifactSinkInput,
  type TiaArtifactSinkResult,
  type TiaFilesystemArtifactSinkOptions,
} from '../../core/artifacts.ts'
import { runPromise } from '../../host/runtime.ts'
import { TiaInvalid, TiaIo } from '../../wire/errors.ts'

export const FILESYSTEM_SINK_NAME = 'filesystem artifact sink'

function urlFor(key: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return `./${key}`
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(key, normalized).toString()
}

/** Writes one artifact file atomically: a temporary sibling, then a rename. */
export const putToDirectory = Effect.fnUntraced(function* (
  directory: string,
  baseUrl: string | undefined,
  input: TiaArtifactSinkInput,
) {
  const target = resolve(directory, input.key)
  const path = relative(directory, target)
  if (!isSafeRelativePath(input.key) || path.startsWith('..') || path === '') {
    return yield* new TiaInvalid({
      message: 'TIA artifact sink key escapes its directory',
    })
  }
  const fs = yield* FileSystem.FileSystem
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(target), { recursive: true })
    yield* fs.writeFile(temporary, input.body)
    yield* fs.rename(temporary, target)
  }).pipe(
    Effect.onError(() =>
      fs.remove(temporary, { force: true }).pipe(Effect.ignore),
    ),
    Effect.mapError(
      (error) =>
        new TiaIo({
          cause: error,
          message:
            error.cause instanceof Error ? error.cause.message : error.message,
        }),
    ),
  )
  const result: TiaArtifactSinkResult = { url: urlFor(input.key, baseUrl) }
  return result
})

export function createFilesystemArtifactSink(
  options: TiaFilesystemArtifactSinkOptions = {},
  root = process.cwd(),
): TiaArtifactSink {
  const directory = resolve(root, options.directory ?? '.tia-artifacts')
  return {
    name: FILESYSTEM_SINK_NAME,
    put: (input) =>
      runPromise(putToDirectory(directory, options.baseUrl, input)),
  }
}

/**
 * Calls a user sink. It may return a value, return a promise, or throw; every
 * outcome becomes a typed failure carrying the sink's own message.
 */
export const putToSink = (sink: TiaArtifactSink, input: TiaArtifactSinkInput) =>
  Effect.tryPromise({
    catch: (error) =>
      new TiaIo({
        message: error instanceof Error ? error.message : String(error),
      }),
    try: async () => sink.put(input),
  })
