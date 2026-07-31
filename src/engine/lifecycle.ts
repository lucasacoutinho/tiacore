import { restoreGraphFromArtifacts } from './artifacts/restore.js'
import type { RestoreArtifactResult } from './artifacts/restore.js'
import { captureBaseline } from './baseline/capture.js'
import { projectFingerprint } from './baseline/fingerprint.js'
import { createRunPlan } from './planning/runtime.js'
import {
  graphDigest,
  purgeGraph,
  readGraph,
} from './state/store.js'
import type {
  Baseline,
  EngineOptions,
  RunPlan,
  RunPlanBaseline,
  TiaRuntimeGraph,
} from './types.js'

export interface RuntimeProjectSnapshot {
  baseline: Baseline | null
  fingerprint: string
}

export interface BeginRuntimeRunInput {
  cacheDir: string
  coverageRequested?: boolean
  fingerprint: string
  ignoredPrefixes: string[]
  options: EngineOptions
  partitioned?: boolean
  root: string
  runner?: string
  testFiles?: string[]
  writeCacheDir?: string
}

export interface BegunRuntimeRun {
  graph: TiaRuntimeGraph | null
  graphDigest: string | null
  plan: RunPlan
}

function runPlanBaseline(
  graph: TiaRuntimeGraph | null,
  restore: RestoreArtifactResult | null,
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
    ...(restore?.provider === undefined
      ? {}
      : { provider: restore.provider }),
    reason: restore?.reason ?? 'local graph loaded',
    sha: graph.baseline.sha || null,
    source: graph.baseline.source ?? null,
  }
}

export function snapshotRuntimeProject(input: {
  fingerprint?: string
  ignoredPrefixes: string[]
  options: EngineOptions
  root: string
  structuralFiles?: string[]
}): RuntimeProjectSnapshot {
  return {
    baseline: captureBaseline(input.root, input.ignoredPrefixes),
    fingerprint:
      input.fingerprint ??
      projectFingerprint(
        input.root,
        input.options,
        input.structuralFiles ?? [],
      ),
  }
}

export async function beginRuntimeRun(
  input: BeginRuntimeRunInput,
): Promise<BegunRuntimeRun> {
  const writeCacheDir = input.writeCacheDir ?? input.cacheDir
  let restore: RestoreArtifactResult | null = null
  if (input.options.fresh) {
    purgeGraph(writeCacheDir)
    restore = { reason: 'fresh graph requested', restored: false }
  } else if (
    !input.partitioned &&
    input.options.artifactProviders.length > 0
  ) {
    restore = await restoreGraphFromArtifacts({
      cacheDir: input.cacheDir,
      ...(input.coverageRequested === undefined
        ? {}
        : { coverageRequested: input.coverageRequested }),
      fingerprint: input.fingerprint,
      log: input.options.log,
      providers: input.options.artifactProviders,
      root: input.root,
      ...(input.runner === undefined ? {} : { runner: input.runner }),
    })
  }

  const graph = readGraph(writeCacheDir)
  const plannedGraph = input.partitioned ? null : graph
  return {
    graph,
    graphDigest: graphDigest(graph),
    plan: createRunPlan({
      baseline: runPlanBaseline(graph, restore, input.partitioned ?? false),
      cachePrefix: '',
      ...(input.coverageRequested === undefined
        ? {}
        : { coverageRequested: input.coverageRequested }),
      fingerprint: input.fingerprint,
      graph: plannedGraph,
      ignoredPrefixes: input.ignoredPrefixes,
      options: input.options,
      root: input.root,
      ...(input.testFiles === undefined
        ? {}
        : { testFiles: input.testFiles }),
    }),
  }
}

export function runtimeProjectUnchanged(input: {
  expected: RuntimeProjectSnapshot
  fingerprint?: string
  ignoredPrefixes: string[]
  options: EngineOptions
  root: string
  structuralFiles?: string[]
}): RuntimeProjectSnapshot | null {
  const current = snapshotRuntimeProject(input)
  if (
    current.baseline === null ||
    input.expected.baseline === null ||
    current.fingerprint !== input.expected.fingerprint ||
    JSON.stringify(current.baseline) !== JSON.stringify(input.expected.baseline)
  ) {
    return null
  }
  return current
}
