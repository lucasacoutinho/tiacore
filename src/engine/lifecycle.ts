import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'

import type {
  Baseline,
  RunPlan,
  RunPlanBaseline,
  RuntimePlanOptions,
  TiaRuntimeGraph,
} from '../core/runtime.ts'
import type { TiaError } from '../wire/errors.ts'
import {
  changesUnavailablePlan,
  gateRuntimePlan,
  planRuntimeChanges,
  runtimePlanCandidates,
  type RuntimePlanInput,
} from './plan/runtime.ts'
import { Baselines, GraphStore } from './ports.ts'
import {
  updateGraph,
  type GraphHeader,
  type GraphUpdateInput,
} from './state/update.ts'

/** What an artifact restore reports to the plan's baseline line. */
export interface RestoreOutcome {
  readonly artifactId?: Array<number | string> | number | string
  readonly provider?: string
  readonly reason: string
  readonly restored: boolean
}

export interface RestoreRequest {
  readonly cacheDir: string
  readonly coverageRequested?: boolean
  readonly fingerprint: string
  readonly root: string
  readonly runner?: string
}

/** Restores a graph from artifact providers into `cacheDir` before planning. */
export type RestoreStep<R = never> = (
  request: RestoreRequest,
) => Effect.Effect<RestoreOutcome, TiaError, R>

export interface ProjectSnapshot {
  readonly baseline: Baseline | null
  readonly fingerprint: string
}

export interface BeginRunInput<R = never> {
  readonly cacheDir: string
  readonly coverageRequested?: boolean
  readonly ignoredPrefixes: readonly string[]
  readonly options: RuntimePlanOptions
  /** A partition records an isolated fragment and always runs everything it owns. */
  readonly partitioned?: boolean
  /** Present when artifact providers are configured. */
  readonly restore?: RestoreStep<R>
  readonly root: string
  readonly runner?: string
  /** The project as the run found it; a commit is checked against it. */
  readonly snapshot: ProjectSnapshot
  readonly testFiles?: readonly string[]
  /** Where the run commits; defaults to `cacheDir`. */
  readonly writeCacheDir?: string
}

/** A planned run: the plan and everything its commit is checked against. */
export interface BegunRun {
  /** Where the run commits. */
  readonly cacheDir: string
  /** The graph read at the start. */
  readonly graph: TiaRuntimeGraph | null
  readonly graphDigest: string | null
  readonly ignoredPrefixes: readonly string[]
  readonly plan: RunPlan
  readonly root: string
  readonly snapshot: ProjectSnapshot
}

function planBaseline(
  graph: TiaRuntimeGraph | null,
  restore: RestoreOutcome | null,
  partitioned: boolean,
): RunPlanBaseline {
  if (partitioned) {
    return {
      origin: 'none',
      reason: 'partitioned run records an isolated graph fragment',
      sha: null,
      source: null,
    }
  }
  if (graph === null) {
    return {
      origin: 'none',
      reason: restore?.reason ?? 'no local graph found',
      sha: null,
      source: null,
    }
  }
  return {
    ...(restore?.artifactId === undefined
      ? {}
      : { artifactId: restore.artifactId }),
    origin: restore?.restored === true ? 'artifact' : 'local',
    ...(restore?.provider === undefined ? {} : { provider: restore.provider }),
    reason: restore?.reason ?? 'local graph loaded',
    sha: graph.baseline.sha || null,
    source: graph.baseline.source ?? null,
  }
}

/**
 * Plans a run: restores and reads the stored graph, applies the fail-safe
 * gates, then detects changes against the graph's baseline and selects.
 */
export const beginRun = Effect.fn('tia.prepare')(function* <R>(
  input: BeginRunInput<R>,
): Effect.fn.Return<BegunRun, TiaError, GraphStore | Baselines | R> {
  const store = yield* GraphStore
  const writeCacheDir = input.writeCacheDir ?? input.cacheDir
  const { fingerprint } = input.snapshot
  let restore: RestoreOutcome | null = null
  if (input.options.fresh) {
    yield* store.purge(writeCacheDir)
    restore = { reason: 'fresh graph requested', restored: false }
  } else if (input.partitioned !== true && input.restore !== undefined) {
    restore = yield* input.restore({
      cacheDir: input.cacheDir,
      ...(input.coverageRequested === undefined
        ? {}
        : { coverageRequested: input.coverageRequested }),
      fingerprint,
      root: input.root,
      ...(input.runner === undefined ? {} : { runner: input.runner }),
    })
  }

  const stored = yield* store.read(writeCacheDir)
  const planInput: RuntimePlanInput = {
    baseline: planBaseline(stored.graph, restore, input.partitioned ?? false),
    ...(input.coverageRequested === undefined
      ? {}
      : { coverageRequested: input.coverageRequested }),
    fingerprint,
    graph: input.partitioned === true ? null : stored.graph,
    options: input.options,
    ...(input.testFiles === undefined ? {} : { testFiles: input.testFiles }),
  }
  const begun = (plan: RunPlan): BegunRun => ({
    cacheDir: writeCacheDir,
    graph: stored.graph,
    graphDigest: stored.digest,
    ignoredPrefixes: input.ignoredPrefixes,
    plan,
    root: input.root,
    snapshot: input.snapshot,
  })
  const gated = gateRuntimePlan(planInput)
  if (gated !== null || planInput.graph === null) {
    return begun(gated ?? changesUnavailablePlan(planInput))
  }

  const baselines = yield* Baselines
  const changes = yield* baselines.changedSince(
    input.root,
    planInput.graph.baseline,
    input.ignoredPrefixes,
  )
  if (changes === null) return begun(changesUnavailablePlan(planInput))
  const present = new Set(
    runtimePlanCandidates(planInput.graph, changes).filter((file) =>
      existsSync(resolve(input.root, file)),
    ),
  )
  return begun(
    planRuntimeChanges(planInput, changes, (file) => present.has(file)),
  )
})

/** The baseline and fingerprint a run starts from. */
export const snapshotProject = Effect.fn('tia.baseline.snapshot')(function* (
  root: string,
  ignoredPrefixes: readonly string[],
  fingerprint: string,
) {
  const baselines = yield* Baselines
  return {
    baseline: yield* baselines.capture(root, ignoredPrefixes),
    fingerprint,
  } satisfies ProjectSnapshot
})

/** The files whose hash differs between two baselines, in code-unit order. */
function baselineDifferences(before: Baseline, after: Baseline): string[] {
  return [
    ...new Set([
      ...Object.keys(before.workingTree),
      ...Object.keys(after.workingTree),
    ]),
  ]
    .filter((file) => before.workingTree[file] !== after.workingTree[file])
    .sort()
}

/** What the committing run states about the graph it leaves. */
export type RunStamp = Pick<
  GraphHeader,
  'complete' | 'coverageComplete' | 'partition'
>

export interface CommitRunInput {
  /** The project's fingerprint now, computed the way the run's start was. */
  readonly fingerprint: string
  readonly run: BegunRun
  readonly stamp: RunStamp
  /** What the run observed. */
  readonly update: Omit<GraphUpdateInput, 'header' | 'previous' | 'root'>
}

/**
 * Why a commit left the stored graph untouched. Each cause has its own tag, so
 * a caller words its own report.
 */
export type CommitSkipped =
  | { readonly _tag: 'FingerprintChanged' }
  | { readonly _tag: 'BaselineUnavailable' }
  | { readonly _tag: 'FilesChanged'; readonly changed: readonly string[] }
  | { readonly _tag: 'Conflict' }

export type CommitOutcome =
  | { readonly _tag: 'Committed'; readonly graph: TiaRuntimeGraph }
  | CommitSkipped

/**
 * Commits what a run observed, unless the project changed underneath it or
 * another writer committed an incompatible graph: its observations then no
 * longer describe the files the next run will see.
 */
export const commitRun = Effect.fn('tia.commit')(function* (
  input: CommitRunInput,
): Effect.fn.Return<
  CommitOutcome,
  TiaError,
  GraphStore | Baselines | FileSystem.FileSystem
> {
  const { fingerprint, run } = input
  if (fingerprint !== run.snapshot.fingerprint) {
    return { _tag: 'FingerprintChanged' }
  }
  const { baseline } = yield* snapshotProject(
    run.root,
    run.ignoredPrefixes,
    fingerprint,
  )
  if (baseline === null) return { _tag: 'BaselineUnavailable' }
  const started = run.snapshot.baseline
  if (
    started === null ||
    JSON.stringify(baseline) !== JSON.stringify(started)
  ) {
    return {
      _tag: 'FilesChanged',
      changed: started === null ? [] : baselineDifferences(started, baseline),
    }
  }

  const { plan } = run
  const graph = yield* updateGraph({
    ...input.update,
    header: {
      ...input.stamp,
      baseline,
      fingerprint,
      updatedAt: new Date().toISOString(),
    },
    previous: plan.mode === 'record' ? null : plan.graph,
    root: run.root,
  })
  const store = yield* GraphStore
  const committed = yield* store.commit(run.cacheDir, {
    expected: run.graph,
    expectedDigest: run.graphDigest,
    graph,
  })
  if (committed.status === 'conflict' || committed.graph === null) {
    return { _tag: 'Conflict' }
  }
  return { _tag: 'Committed', graph: committed.graph }
})
