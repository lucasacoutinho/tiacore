import {
  DEFAULT_CACHE_DIR,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
} from '../core/defaults.ts'
import { freshRequested } from '../core/env.ts'
import type {
  TiaArtifactSource,
  TiaArtifactTrustPolicy,
} from '../core/artifacts.ts'
import type { TiaReplayAdapter } from '../core/replay.ts'
import type { RuntimePlanOptions } from '../core/runtime.ts'
import type { FingerprintOptions } from './baseline/options.ts'
import { resolveCacheDir } from './host-path.ts'

export interface TiaCoreOptions {
  /** Where to restore a baseline graph from when no compatible local one exists. */
  artifacts?: TiaArtifactSource | TiaArtifactSource[]
  /** Which restored artifacts to trust; unsigned ones are rejected unless allowed. */
  artifactTrust?: TiaArtifactTrustPolicy
  cacheDir?: string
  exclude?: string[]
  files: string[]
  fresh?: boolean
  fingerprint?: string
  ignoreChanges?: string[]
  include?: string[]
  log?: boolean
  onUnknownChange?: 'full' | 'ignore'
  replayAdapters?: TiaReplayAdapter | TiaReplayAdapter[]
  root?: string
  runner: string
  testFiles?: string[]
}

export interface TiaObservation {
  duration?: number
  file: string
  files: string[]
  fullName: string
  id: string
  state: 'failed' | 'passed' | 'skipped'
}

export interface TiaCoreEngineOptions
  extends FingerprintOptions, RuntimePlanOptions {
  readonly artifacts: readonly TiaArtifactSource[]
  readonly artifactTrust: TiaArtifactTrustPolicy
  readonly cacheDir: string
  readonly log: boolean
  readonly replayAdapters: readonly TiaReplayAdapter[]
}

export function normalizedOptions(
  root: string,
  options: TiaCoreOptions,
): TiaCoreEngineOptions {
  return {
    artifacts:
      options.artifacts === undefined
        ? []
        : Array.isArray(options.artifacts)
          ? options.artifacts
          : [options.artifacts],
    artifactTrust: options.artifactTrust ?? {},
    cacheDir: resolveCacheDir(root, options.cacheDir ?? DEFAULT_CACHE_DIR),
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
    frameworkFingerprint: '',
    fresh: options.fresh ?? freshRequested(process.env),
    ignoreChanges: options.ignoreChanges ?? [],
    include: options.include ?? DEFAULT_INCLUDE,
    log: options.log ?? true,
    onUnknownChange: options.onUnknownChange ?? 'full',
    replayAdapters:
      options.replayAdapters === undefined
        ? []
        : Array.isArray(options.replayAdapters)
          ? options.replayAdapters
          : [options.replayAdapters],
  }
}
