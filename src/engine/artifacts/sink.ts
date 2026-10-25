import { randomUUID } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import {
  MANIFEST_KEY,
  resolveRetention,
} from '../../core/artifact-retention.ts'
import {
  isSafeRelativePath,
  type TiaArtifactRetentionOptions,
  type TiaArtifactSink,
  type TiaArtifactSinkInput,
  type TiaArtifactSinkResult,
} from '../../core/artifacts.ts'
import {
  errorMessage,
  systemIoError,
  TiaInvalid,
  TiaIo,
} from '../../wire/errors.ts'
import { pruneArtifactDirectory } from './retention.ts'

export const FILESYSTEM_SINK_NAME = 'filesystem artifact sink'

function urlFor(key: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return `./${key}`
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(key, normalized).toString()
}

/**
 * Writes one artifact file atomically: a temporary sibling, then a rename.
 * The publisher writes the manifest last, so once that file is in place the
 * directory is pruned to `retention`. Pruning never fails the write.
 */
export const putToDirectory = Effect.fnUntraced(function* (
  directory: string,
  baseUrl: string | undefined,
  input: TiaArtifactSinkInput,
  retention?: TiaArtifactRetentionOptions | false,
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
    Effect.mapError(systemIoError),
  )
  const policy = resolveRetention(retention)
  if (policy !== null && input.key === MANIFEST_KEY) {
    yield* pruneArtifactDirectory(directory, policy, input.body).pipe(
      Effect.ignoreCause,
    )
  }
  const result: TiaArtifactSinkResult = { url: urlFor(input.key, baseUrl) }
  return result
})

/**
 * Calls a user sink. It may return a value, return a promise, or throw; every
 * outcome becomes a typed failure carrying the sink's own message.
 */
export const putToSink = (sink: TiaArtifactSink, input: TiaArtifactSinkInput) =>
  Effect.tryPromise({
    catch: (error) => new TiaIo({ message: errorMessage(error) }),
    try: async () => sink.put(input),
  })
