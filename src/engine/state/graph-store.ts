import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'

import { GraphStore } from '../ports.ts'
import { commitProtocol } from './commit.ts'
import { makeLock } from './lock.ts'
import { makeStateFiles } from './state-files.ts'

/**
 * The live graph store: a segmented, content-addressed store under the cache
 * directory, written atomically under a commit lock.
 */
export const GraphStoreLive = Layer.effect(
  GraphStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const files = makeStateFiles(fs)
    const { locked } = makeLock(fs)

    return GraphStore.of({
      commit: (cacheDir, commit) =>
        commitProtocol(
          {
            locked: (options, body) =>
              locked(
                cacheDir,
                options,
                files.cleanAbandonedWrites(cacheDir).pipe(Effect.andThen(body)),
              ),
            read: files.read(cacheDir),
            readGeneration: files.readGeneration(cacheDir),
            write: (graph) => files.write(cacheDir, graph),
          },
          commit,
        ),
      purge: (cacheDir) => files.purge(cacheDir),
      read: (cacheDir) => files.read(cacheDir),
    })
  }),
)
