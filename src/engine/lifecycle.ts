import { restoreGraphFromArtifacts } from './artifacts/restore.js'
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
  if (input.options.fresh) {
    purgeGraph(writeCacheDir)
  } else if (
    !input.partitioned &&
    input.options.artifactProviders.length > 0
  ) {
    await restoreGraphFromArtifacts({
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
  return {
    graph,
    graphDigest: graphDigest(graph),
    plan: createRunPlan({
      cachePrefix: '',
      ...(input.coverageRequested === undefined
        ? {}
        : { coverageRequested: input.coverageRequested }),
      fingerprint: input.fingerprint,
      graph: input.partitioned ? null : graph,
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
