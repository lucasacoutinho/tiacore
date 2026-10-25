import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'

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
  readonly fingerprint: string
  readonly ignoredPrefixes: readonly string[]
  readonly options: RuntimePlanOptions
  /** A partition records an isolated fragment and always runs everything it owns. */
  readonly partitioned?: boolean
  /** Present when artifact providers are configured. */
  readonly restore?: RestoreStep<R>
  readonly root: string
  readonly runner?: string
  readonly testFiles?: readonly string[]
  /** Where the run commits; defaults to `cacheDir`. */
  readonly writeCacheDir?: string
}

export interface BegunRun {
  /** The graph read at the start, which a commit is checked against. */
  readonly graph: TiaRuntimeGraph | null
  readonly graphDigest: string | null
  readonly plan: RunPlan
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
      fingerprint: input.fingerprint,
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
    fingerprint: input.fingerprint,
    graph: input.partitioned === true ? null : stored.graph,
    options: input.options,
    ...(input.testFiles === undefined ? {} : { testFiles: input.testFiles }),
  }
  const gated = gateRuntimePlan(planInput)
  if (gated !== null || planInput.graph === null) {
    return {
      graph: stored.graph,
      graphDigest: stored.digest,
      plan: gated ?? changesUnavailablePlan(planInput),
    }
  }

  const baselines = yield* Baselines
  const changes = yield* baselines.changedSince(
    input.root,
    planInput.graph.baseline,
    input.ignoredPrefixes,
  )
  if (changes === null) {
    return {
      graph: stored.graph,
      graphDigest: stored.digest,
      plan: changesUnavailablePlan(planInput),
    }
  }
  const present = new Set(
    runtimePlanCandidates(planInput.graph, changes).filter((file) =>
      existsSync(resolve(input.root, file)),
    ),
  )
  return {
    graph: stored.graph,
    graphDigest: stored.digest,
    plan: planRuntimeChanges(planInput, changes, (file) => present.has(file)),
  }
})

/** The baseline and fingerprint a run starts from. */
export const snapshotProject = Effect.fnUntraced(function* (
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

/**
 * The project's snapshot now, or null when it differs from `expected`: a run
 * whose project changed underneath it must not commit, because its
 * observations no longer describe the files the next run will see.
 */
export const projectUnchanged = Effect.fnUntraced(function* (
  expected: ProjectSnapshot,
  root: string,
  ignoredPrefixes: readonly string[],
  fingerprint: string,
) {
  const current = yield* snapshotProject(root, ignoredPrefixes, fingerprint)
  if (
    current.baseline === null ||
    expected.baseline === null ||
    current.fingerprint !== expected.fingerprint ||
    JSON.stringify(current.baseline) !== JSON.stringify(expected.baseline)
  ) {
    return null
  }
  return current
})
