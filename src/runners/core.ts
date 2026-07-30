import { resolve } from 'node:path'

import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
} from '../shared/constants.js'
import {
  artifactProviders,
  restoreGraphFromArtifacts,
} from '../artifacts/restore.js'
import { hashBytes, projectFingerprint } from '../graph/fingerprint.js'
import { captureBaseline } from '../graph/baseline.js'
import { createRunPlan } from '../graph/plan.js'
import { updateGraph } from '../graph/update.js'
import {
  commitGraph,
  graphDigest,
  purgeGraph,
  readGraph,
} from '../graph/state.js'
import { projectRelative, resolveCacheDir } from '../shared/paths.js'
import {
  notifyReplayAdapters,
  replayedResults as cachedReplayResults,
  replayRunEvent,
} from '../runtime/replay.js'
import type {
  CachedTestResult,
  Baseline,
  NormalizedOptions,
  RunPlan,
  TiaRuntimeGraph,
  TiaReplayAdapter,
  TiaTestEdge,
} from '../shared/types.js'

export interface TiaCoreOptions {
  cacheDir?: string
  exclude?: string[]
  files: string[]
  fresh?: boolean
  fingerprint?: string
  artifacts?: import('../shared/types.js').TiaArtifactSource | import('../shared/types.js').TiaArtifactSource[]
  ignoreChanges?: string[]
  include?: string[]
  log?: boolean
  onUnknownChange?: 'full' | 'ignore'
  replayAdapters?: TiaReplayAdapter | TiaReplayAdapter[]
  root?: string
  runner: string
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
): NormalizedOptions {
  return {
    artifactProviders: artifactProviders(options.artifacts),
    cacheDir: resolveCacheDir(root, options.cacheDir ?? '.tia'),
    coverage: false,
    enabled: true,
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
    fresh: options.fresh ?? false,
    frameworkAdapters: [],
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
    replayReporters: [],
  }
}

export class TiaCore {
  readonly cacheDir: string
  readonly options: NormalizedOptions
  readonly root: string

  private baselineAtStart: Baseline | null = null
  private fingerprintAtStart = ''
  private graphDigestAtStart: string | null = null
  private planValue: RunPlan | null = null
  private readonly runner: string
  private readonly runnerFingerprint: string
  private readonly runnerFiles: string[]

  constructor(options: TiaCoreOptions) {
    this.root = resolve(options.root ?? process.cwd())
    this.options = normalizedOptions(this.root, options)
    this.cacheDir = resolve(this.options.cacheDir, options.runner)
    this.runner = options.runner
    this.runnerFingerprint = options.fingerprint ?? ''
    this.runnerFiles = [...options.files].sort()
    this.baselineAtStart = null
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
    this.fingerprintAtStart = this.fingerprint()

    if (this.options.fresh) {
      purgeGraph(this.cacheDir)
    } else if (this.options.artifactProviders.length > 0) {
      await restoreGraphFromArtifacts({
        cacheDir: this.cacheDir,
        fingerprint: this.fingerprintAtStart,
        log: this.options.log,
        providers: this.options.artifactProviders,
        root: this.root,
        runner: this.runner,
      })
    }

    const graph = readGraph(this.cacheDir)
    this.graphDigestAtStart = graphDigest(graph)
    this.baselineAtStart = captureBaseline(
      this.root,
      cachePrefix === '' ? [] : [cachePrefix],
    )
    this.planValue = createRunPlan({
      cachePrefix,
      fingerprint: this.fingerprintAtStart,
      graph,
      ignoredPrefixes: cachePrefix === '' ? [] : [cachePrefix],
      options: this.options,
      root: this.root,
    })

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
    const baseline = captureBaseline(
      this.root,
      cachePrefix === '' ? [] : [cachePrefix],
    )

    if (
      baseline === null ||
      this.baselineAtStart === null ||
      JSON.stringify(baseline) !== JSON.stringify(this.baselineAtStart) ||
      this.fingerprint() !== this.fingerprintAtStart
    ) {
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

    graph.baseline = baseline
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
      }),
    )
  }

}
