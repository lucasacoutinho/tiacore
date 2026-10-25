import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type { Baseline, TiaRuntimeGraph } from '../core/runtime.ts'
import type { TiaIo } from '../wire/errors.ts'

// The engine's seams. Each has a live adapter (file system, git) and an
// in-memory adapter that tests and the verifier's isolated phases use.

export interface StoredGraph {
  /** Null when no graph is stored or the stored one is stale or damaged. */
  readonly graph: TiaRuntimeGraph | null
  /** Digest of the stored generation, used to detect concurrent writers. */
  readonly digest: string | null
}

export interface GraphCommit {
  /** The graph the run started from, and its digest at that time. */
  readonly expected: TiaRuntimeGraph | null
  readonly expectedDigest: string | null
  readonly graph: TiaRuntimeGraph
  readonly lockTimeoutMs?: number
  readonly staleLockMs?: number
}

export type GraphCommitResult =
  | { readonly status: 'committed'; readonly graph: TiaRuntimeGraph }
  | { readonly status: 'merged'; readonly graph: TiaRuntimeGraph }
  | { readonly status: 'conflict'; readonly graph: TiaRuntimeGraph | null }

/**
 * Runtime graph storage under a cache directory. Reads never fail: anything
 * unreadable is reported as no graph. A commit writes atomically under a lock,
 * merges with a concurrent writer when their changes are compatible, and
 * otherwise reports a conflict without writing.
 */
export class GraphStore extends Context.Service<
  GraphStore,
  {
    readonly read: (cacheDir: string) => Effect.Effect<StoredGraph>
    readonly commit: (
      cacheDir: string,
      commit: GraphCommit,
    ) => Effect.Effect<GraphCommitResult, TiaIo>
    readonly purge: (cacheDir: string) => Effect.Effect<void, TiaIo>
  }
>()('tiacore/engine/GraphStore') {}

/**
 * Project baselines. Inside a git repository a baseline is a commit plus the
 * hashes of files that differ from it; elsewhere it hashes every project file.
 * Null means change detection is unavailable, which the caller must treat as a
 * reason to run everything.
 */
export class Baselines extends Context.Service<
  Baselines,
  {
    readonly capture: (
      root: string,
      ignoredPrefixes: readonly string[],
    ) => Effect.Effect<Baseline | null>
    readonly changedSince: (
      root: string,
      baseline: Baseline,
      ignoredPrefixes: readonly string[],
    ) => Effect.Effect<readonly string[] | null>
    readonly currentSha: (root: string) => Effect.Effect<string | null>
    readonly isAncestor: (
      root: string,
      ancestor: string,
      head: string,
    ) => Effect.Effect<boolean>
  }
>()('tiacore/engine/Baselines') {}
