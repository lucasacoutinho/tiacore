import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'

import {
  DEFAULT_CACHE_DIR,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
} from '../core/defaults.ts'
import { freshRequested } from '../core/env.ts'
import type { TiaReplayAdapter } from '../core/replay.ts'
import type {
  CachedTestResult,
  RunPlan,
  RuntimePlanOptions,
  TiaRuntimeGraph,
  TiaTestEdge,
} from '../core/runtime.ts'
import { runPromise } from '../host/runtime.ts'
import {
  hashBytes,
  projectFingerprint,
  type FingerprintOptions,
} from './baseline/fingerprint.ts'
import { projectRelative, resolveCacheDir } from './host-path.ts'
import {
  beginRun,
  projectUnchanged,
  snapshotProject,
  type ProjectSnapshot,
} from './lifecycle.ts'
import { EngineLive } from './layers.ts'
import { GraphStore } from './ports.ts'
import {
  notifyReplayAdapters,
  replayedResults,
  replayRunEvent,
} from './replay.ts'
import { updateGraph } from './state/update.ts'
import { writeVerificationSnapshot } from './verification-snapshot.ts'

export interface TiaCoreOptions {
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
  readonly cacheDir: string
  readonly log: boolean
  readonly replayAdapters: readonly TiaReplayAdapter[]
}

function normalizedOptions(
  root: string,
  options: TiaCoreOptions,
): TiaCoreEngineOptions {
  return {
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

/**
 * The runner-neutral core that the Node, Bun, Playwright and generic adapters
 * share: prepare plans the run from the stored graph, commit records what the
 * run observed. A commit is skipped when the project changed during the run
 * or another writer committed an incompatible graph.
 */
export class TiaCore {
  readonly cacheDir: string
  readonly options: TiaCoreEngineOptions
  readonly root: string

  private snapshotAtStart: ProjectSnapshot | null = null
  private graphAtStart: TiaRuntimeGraph | null = null
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
  }

  get plan(): RunPlan {
    if (this.planValue === null)
      throw new Error('TIA core has not been prepared')
    return this.planValue
  }

  async prepare(): Promise<RunPlan> {
    const ignoredPrefixes = this.ignoredPrefixes()
    const program = Effect.gen({ self: this }, function* () {
      const fingerprint = yield* this.fingerprint()
      const snapshot = yield* snapshotProject(
        this.root,
        ignoredPrefixes,
        fingerprint,
      )
      const begun = yield* beginRun<never>({
        cacheDir: this.cacheDir,
        fingerprint,
        ignoredPrefixes,
        options: this.options,
        root: this.root,
        runner: this.runner,
        ...(this.runnerTestFiles === undefined
          ? {}
          : { testFiles: this.runnerTestFiles }),
      })
      return { begun, snapshot }
    })
    const { begun, snapshot } = await runPromise(
      program.pipe(Effect.provide(EngineLive)),
    )
    this.snapshotAtStart = snapshot
    this.graphAtStart = begun.graph
    this.graphDigestAtStart = begun.graphDigest
    this.planValue = begun.plan

    const adapters = this.options.replayAdapters
    const start = replayRunEvent(begun.plan)
    await notifyReplayAdapters(
      adapters,
      'onRunStart',
      (adapter) => adapter.onRunStart?.(start),
      console.warn,
    )
    for (const result of this.replayedResults()) {
      const event = { result: structuredClone(result) }
      await notifyReplayAdapters(
        adapters,
        'onTestReplayed',
        (adapter) => adapter.onTestReplayed?.(event),
        console.warn,
      )
    }
    return begun.plan
  }

  async commit(
    observations: TiaObservation[],
    wholeTestFiles: string[],
  ): Promise<TiaRuntimeGraph | null> {
    const plan = this.plan
    const expected = this.snapshotAtStart
    if (expected === null) return null
    const touchedFiles = new Set([
      ...wholeTestFiles,
      ...observations.map((observation) => observation.file),
    ])

    const program = Effect.gen({ self: this }, function* () {
      const fingerprint = yield* this.fingerprint()
      const snapshot = yield* projectUnchanged(
        expected,
        this.root,
        this.ignoredPrefixes(),
        fingerprint,
      )
      if (snapshot === null || snapshot.baseline === null) return null

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
          files: [...new Set([observation.file, ...observation.files])].sort(),
        })
      }
      const graph = yield* updateGraph({
        executedFiles: touchedFiles,
        fullyExecutedFiles: wholeTestFiles,
        previous:
          plan.mode === 'record' || plan.graph === null ? null : plan.graph,
        results,
        root: this.root,
        testEdges,
      })
      graph.baseline = snapshot.baseline
      graph.complete = true
      graph.coverageComplete = false
      graph.fingerprint = expected.fingerprint
      graph.updatedAt = new Date().toISOString()

      const store = yield* GraphStore
      const committed = yield* store.commit(this.cacheDir, {
        expected: this.graphAtStart,
        expectedDigest: this.graphDigestAtStart,
        graph,
      })
      if (committed.status === 'conflict' || committed.graph === null)
        return null
      yield* writeVerificationSnapshot({
        env: process.env,
        executedTestIds: observations.map((observation) => observation.id),
        graph: committed.graph,
        plan,
        runner: this.runner,
        success: observations.every(
          (observation) => observation.state !== 'failed',
        ),
      })
      return committed.graph
    })
    const committed = await runPromise(
      program.pipe(Effect.withSpan('tia.commit'), Effect.provide(EngineLive)),
    )
    if (committed === null) return null

    const complete = {
      ...replayRunEvent(plan),
      coverageReportDirectory: null,
      executedTestFiles: [...touchedFiles].sort(),
    }
    await notifyReplayAdapters(
      this.options.replayAdapters,
      'onRunComplete',
      (adapter) => adapter.onRunComplete?.(complete),
      console.warn,
    )
    return committed
  }

  replayedResults(): CachedTestResult[] {
    return replayedResults(this.plan)
  }

  private ignoredPrefixes(): string[] {
    const prefix = projectRelative(this.root, this.options.cacheDir) ?? ''
    return prefix === '' ? [] : [prefix]
  }

  private fingerprint() {
    return projectFingerprint(this.root, this.options).pipe(
      Effect.map((core) =>
        hashBytes(
          JSON.stringify({
            core,
            files: this.runnerFiles,
            fingerprint: this.runnerFingerprint,
            runner: this.runner,
            testFiles: this.runnerTestFiles,
          }),
        ),
      ),
    )
  }
}
