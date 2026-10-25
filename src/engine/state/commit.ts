import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import type { TiaIo } from '../../wire/errors.ts'
import type { GraphCommit, GraphCommitResult, StoredGraph } from '../ports.ts'
import { mergeConcurrentGraphs } from './reconcile.ts'
import { graphDigest } from './segments.ts'

/**
 * What the commit protocol needs from a store. `locked` runs its body holding
 * the store's commit lock and yields none when the lock could not be taken.
 */
export interface CommitBackend {
  readonly locked: <A>(
    commit: GraphCommit,
    body: Effect.Effect<A, TiaIo>,
  ) => Effect.Effect<Option.Option<A>, TiaIo>
  readonly read: Effect.Effect<StoredGraph>
  readonly readGeneration: Effect.Effect<string | null>
  readonly write: (graph: TiaRuntimeGraph) => Effect.Effect<void, TiaIo>
}

const conflict = (graph: TiaRuntimeGraph | null): GraphCommitResult => ({
  graph,
  status: 'conflict',
})
const landed = (
  status: 'committed' | 'merged',
  graph: TiaRuntimeGraph,
): GraphCommitResult => ({ graph, status })

/**
 * The transaction shared by every store.
 *
 * - If the caller's expected graph does not match its digest, nothing is
 *   written (conflict).
 * - Under the lock, if the stored generation is still the expected one, the
 *   proposal is written as is.
 * - Otherwise a concurrent writer committed first: the proposal merges onto
 *   the stored graph when the changes are compatible, and is a conflict when
 *   they are not or when the stored graph vanished.
 */
export const commitProtocol = Effect.fnUntraced(function* (
  backend: CommitBackend,
  commit: GraphCommit,
) {
  if (graphDigest(commit.expected) !== commit.expectedDigest) {
    const current = yield* backend.read
    return conflict(current.graph)
  }

  const outcome = yield* backend.locked(
    commit,
    Effect.gen(function* () {
      const unchanged =
        commit.expectedDigest !== null &&
        (yield* backend.readGeneration) === commit.expectedDigest
      const current: StoredGraph = unchanged
        ? { digest: commit.expectedDigest, graph: null }
        : yield* backend.read
      if (unchanged || current.digest === commit.expectedDigest) {
        yield* backend.write(commit.graph)
        return landed('committed', commit.graph)
      }
      if (current.graph === null) {
        return conflict(null)
      }
      const merged = mergeConcurrentGraphs(
        commit.expected,
        current.graph,
        commit.graph,
      )
      if (merged === null) {
        return conflict(current.graph)
      }
      yield* backend.write(merged)
      return landed('merged', merged)
    }),
  )

  if (Option.isSome(outcome)) return outcome.value
  const current = yield* backend.read
  return conflict(current.graph)
})
