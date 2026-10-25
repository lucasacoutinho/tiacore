import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { isStoredGraph } from './graph-guard.ts'
import { GraphStore, type StoredGraph } from '../ports.ts'
import { commitProtocol } from './commit.ts'
import { cloneGraph } from './coverage.ts'
import { graphGeneration } from './segments.ts'

interface Held {
  readonly digest: string
  readonly graph: TiaRuntimeGraph
}

/**
 * An in-memory graph store. It keeps a copy of each graph per cache directory,
 * computes the same digests as the live store, and follows the same commit
 * protocol. Commits to one directory run one at a time, as under the live lock.
 */
export const GraphStoreMemory = Layer.sync(GraphStore, () => {
  const held = new Map<string, Held>()
  const queues = new Map<string, Promise<unknown>>()

  const read = (cacheDir: string): Effect.Effect<StoredGraph> =>
    Effect.sync(() => {
      const entry = held.get(cacheDir)
      // Like the live store, a stored graph of another schema reads as none.
      return entry === undefined || !isStoredGraph(entry.graph)
        ? { digest: null, graph: null }
        : { digest: entry.digest, graph: cloneGraph(entry.graph) }
    })

  const write = (cacheDir: string, graph: TiaRuntimeGraph) =>
    Effect.sync(() => {
      held.set(cacheDir, {
        digest: graphGeneration(graph),
        graph: cloneGraph(graph),
      })
    })

  /** Serializes bodies per directory so concurrent commits cannot interleave. */
  const exclusive = <A, E>(cacheDir: string, body: Effect.Effect<A, E>) =>
    Effect.promise(async () => {
      const previous = queues.get(cacheDir) ?? Promise.resolve()
      const run = previous.then(() => Effect.runPromiseExit(body))
      queues.set(
        cacheDir,
        run.then(
          () => undefined,
          () => undefined,
        ),
      )
      return run
    }).pipe(Effect.flatMap((exit) => exit))

  return GraphStore.of({
    commit: (cacheDir, commit) =>
      commitProtocol(
        {
          locked: (_options, body) =>
            exclusive(cacheDir, body).pipe(Effect.asSome),
          read: read(cacheDir),
          readGeneration: Effect.map(read(cacheDir), (stored) => stored.digest),
          write: (graph) => write(cacheDir, graph),
        },
        commit,
      ),
    purge: (cacheDir) =>
      Effect.sync(() => {
        held.delete(cacheDir)
      }),
    read,
  })
})
