import { resolve } from 'node:path'

import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
} from '../shared/constants.js'
import {
  artifactProviders,
} from './artifacts/restore.js'
import { hashBytes, projectFingerprint } from './baseline/fingerprint.js'
import {
  beginRuntimeRun,
  runtimeProjectUnchanged,
  snapshotRuntimeProject,
  type RuntimeProjectSnapshot,
} from './lifecycle.js'
import { updateGraph } from './state/update.js'
import {
  commitGraph,
} from './state/store.js'
import { projectRelative, resolveCacheDir } from '../shared/paths.js'
import {
  notifyReplayAdapters,
  replayedResults as cachedReplayResults,
  replayRunEvent,
} from './replay/index.js'
import type {
  CachedTestResult,
  EngineOptions,
  RunPlan,
  TiaRuntimeGraph,
  TiaTestEdge,
} from './types.js'
import type { TiaReplayAdapter } from './replay/types.js'

export interface TiaCoreOptions {
  cacheDir?: string
  exclude?: string[]
  files: string[]
  fresh?: boolean
  fingerprint?: string
  artifacts?: import('./artifacts/types.js').TiaArtifactSource | import('./artifacts/types.js').TiaArtifactSource[]
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

function normalizedOptions(
  root: string,
  options: TiaCoreOptions,
): EngineOptions {
  return {
    artifactProviders: artifactProviders(options.artifacts),
    cacheDir: resolveCacheDir(root, options.cacheDir ?? '.tia'),
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
    fresh: options.fresh ?? false,
    frameworkFingerprint: '',
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

export class TiaCore {
  readonly cacheDir: string
  readonly options: EngineOptions
  readonly root: string

  private snapshotAtStart: RuntimeProjectSnapshot | null = null
  private fingerprintAtStart = ''
  private graphDigestAtStart: string | null = null
  private planValue: RunPlan | null = null
  private readonly runner: string
  private readonly runnerFingerprint: string
  private readonly runnerFiles: string[]
  private readonly runnerTestFiles: string[] | undefined

  constructor(options: TiaCoreOptions) {
    this.root = resolve(options.root ?? process.cwd())
    this.options = normalizedOptions(this.root, options)
    this.cacheDir = resolve(this.options.cacheDir, options.runner)
    this.runner = options.runner
    this.runnerFingerprint = options.fingerprint ?? ''
    this.runnerFiles = [...options.files].sort()
    this.runnerTestFiles =
      options.testFiles === undefined
        ? undefined
        : [...options.testFiles].sort()
    this.snapshotAtStart = null
  }

  get plan(): RunPlan {
    if (this.planValue === null) {
      throw new Error('TIA core has not been prepared')
    }
    return this.planValue
  }

  async prepare(): Promise<RunPlan> {
    const cachePrefix =
      projectRelative(this.root, this.options.cacheDir) ?? ''
    const ignoredPrefixes = cachePrefix === '' ? [] : [cachePrefix]
    this.snapshotAtStart = snapshotRuntimeProject({
      fingerprint: this.fingerprint(),
      ignoredPrefixes,
      options: this.options,
      root: this.root,
    })
    this.fingerprintAtStart = this.snapshotAtStart.fingerprint
    const begun = await beginRuntimeRun({
      cacheDir: this.cacheDir,
      fingerprint: this.fingerprintAtStart,
      ignoredPrefixes,
      options: this.options,
      root: this.root,
      runner: this.runner,
      ...(this.runnerTestFiles === undefined
        ? {}
        : { testFiles: this.runnerTestFiles }),
    })
    this.graphDigestAtStart = begun.graphDigest
    this.planValue = begun.plan

    await notifyReplayAdapters(
      this.options.replayAdapters,
      'onRunStart',
      replayRunEvent(this.planValue),
      console.warn,
    )
    for (const result of this.replayedResults()) {
      await notifyReplayAdapters(
        this.options.replayAdapters,
        'onTestReplayed',
        { result: structuredClone(result) },
        console.warn,
      )
    }

    return this.planValue
  }

  async commit(
    observations: TiaObservation[],
    wholeTestFiles: string[],
  ): Promise<TiaRuntimeGraph | null> {
    const plan = this.plan
    const cachePrefix =
      projectRelative(this.root, this.options.cacheDir) ?? ''
    if (this.snapshotAtStart === null) {
      return null
    }
    const snapshot = runtimeProjectUnchanged({
      expected: this.snapshotAtStart,
      fingerprint: this.fingerprint(),
      ignoredPrefixes: cachePrefix === '' ? [] : [cachePrefix],
      options: this.options,
      root: this.root,
    })
    if (snapshot?.baseline === null || snapshot === null) {
      return null
    }

    const results = new Map<string, CachedTestResult>()
    const testEdges = new Map<string, TiaTestEdge>()
    for (const observation of observations) {
      results.set(observation.id, {
        ...(observation.duration === undefined
          ? {}
          : { duration: observation.duration }),
        file: observation.file,
        fullName: observation.fullName,
        id: observation.id,
        state: observation.state,
      })
      testEdges.set(observation.id, {
        file: observation.file,
        files: [
          ...new Set([observation.file, ...observation.files]),
        ].sort(),
      })
    }

    const touchedFiles = new Set([
      ...wholeTestFiles,
      ...observations.map((observation) => observation.file),
    ])
    const graph = updateGraph({
      executedFiles: touchedFiles,
      fullyExecutedFiles: wholeTestFiles,
      previous:
        plan.mode === 'record' || plan.graph === null
          ? null
          : plan.graph,
      results,
      root: this.root,
      testEdges,
    })

    graph.baseline = snapshot.baseline
    graph.complete = true
    graph.coverageComplete = false
    graph.fingerprint = this.fingerprintAtStart
    graph.updatedAt = new Date().toISOString()
    const committed = await commitGraph(this.cacheDir, {
      expected: plan.graph,
      expectedDigest: this.graphDigestAtStart,
      graph,
    })
    if (committed.status === 'conflict' || committed.graph === null) {
      return null
    }

    await notifyReplayAdapters(
      this.options.replayAdapters,
      'onRunComplete',
      {
        ...replayRunEvent(plan),
        coverageReportDirectory: null,
        executedTestFiles: [...touchedFiles].sort(),
      },
      console.warn,
    )
    return committed.graph
  }

  replayedResults(): CachedTestResult[] {
    return cachedReplayResults(this.plan)
  }

  private fingerprint(): string {
    return hashBytes(
      JSON.stringify({
        core: projectFingerprint(this.root, this.options),
        files: this.runnerFiles,
        fingerprint: this.runnerFingerprint,
        runner: this.runner,
        testFiles: this.runnerTestFiles,
      }),
    )
  }

}
