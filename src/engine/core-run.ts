import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'

import type {
  CachedTestResult,
  RunPlan,
  TiaRuntimeGraph,
  TiaTestEdge,
} from '../core/runtime.ts'
import type { HostServices } from '../host/runtime.ts'
import type { TiaError } from '../wire/errors.ts'
import { hashBytes, projectFingerprint } from './baseline/fingerprint.ts'
import {
  normalizedOptions,
  type TiaCoreEngineOptions,
  type TiaCoreOptions,
  type TiaObservation,
} from './core-options.ts'
import { projectRelative } from './host-path.ts'
import { artifactRestore } from './artifacts/restore-step.ts'
import { EngineLive } from './layers.ts'
import {
  beginRun,
  commitRun,
  snapshotProject,
  type BegunRun,
} from './lifecycle.ts'
import { notifyRunComplete, notifyRunStart, replayedResults } from './replay.ts'
import {
  verificationTarget,
  writeVerificationSnapshot,
  type VerificationTarget,
} from './verification-snapshot.ts'

/** What a prepared run keeps for its commit. */
interface Prepared {
  readonly run: BegunRun
  /** Read once at prepare, so a misconfiguration fails before the tests run. */
  readonly verification: VerificationTarget | undefined
}

/**
 * The runner-neutral core that the Node, Bun, Playwright and generic adapters
 * share, as Effects: prepare plans the run from the stored graph, commit
 * records what the run observed. A commit is skipped when the project changed
 * during the run or another writer committed an incompatible graph. `TiaCore`
 * is the public Promise form; runners written as Effects use this directly.
 */
export class CoreRun {
  readonly cacheDir: string
  readonly options: TiaCoreEngineOptions
  readonly root: string

  private prepared: Prepared | null = null
  private readonly runner: string
  private readonly runnerFingerprint: string
  private readonly runnerFiles: string[]
  private readonly runnerTestFiles: string[] | undefined

  /** `env` is where TIA_VERIFICATION_DIRECTORY and TIA_VERIFICATION_PHASE are read from. */
  constructor(
    options: TiaCoreOptions,
    private readonly env: Readonly<
      Record<string, string | undefined>
    > = process.env,
  ) {
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
    return this.preparedRun().run.plan
  }

  prepare(): Effect.Effect<RunPlan, TiaError, HostServices> {
    return Effect.gen({ self: this }, function* () {
      const verification = yield* verificationTarget(this.env)
      const ignoredPrefixes = this.ignoredPrefixes()
      const fingerprint = yield* this.fingerprint()
      const snapshot = yield* snapshotProject(
        this.root,
        ignoredPrefixes,
        fingerprint,
      )
      const restore = yield* artifactRestore(
        this.options.artifacts,
        this.options.log,
        this.options.artifactTrust,
      )
      const run = yield* beginRun({
        cacheDir: this.cacheDir,
        ...(restore === undefined ? {} : { restore }),
        ignoredPrefixes,
        options: this.options,
        root: this.root,
        runner: this.runner,
        snapshot,
        ...(this.runnerTestFiles === undefined
          ? {}
          : { testFiles: this.runnerTestFiles }),
      })
      this.prepared = { run, verification }
      yield* Effect.promise(() =>
        notifyRunStart(this.options.replayAdapters, run.plan, console.warn),
      )
      return run.plan
    }).pipe(Effect.provide(EngineLive))
  }

  /** The committed graph, or null when the commit was skipped. */
  commit(
    observations: TiaObservation[],
    wholeTestFiles: string[],
  ): Effect.Effect<TiaRuntimeGraph | null, TiaError, HostServices> {
    const { run, verification } = this.preparedRun()
    const touchedFiles = new Set([
      ...wholeTestFiles,
      ...observations.map((observation) => observation.file),
    ])
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

    return Effect.gen({ self: this }, function* () {
      const outcome = yield* commitRun({
        fingerprint: yield* this.fingerprint(),
        run,
        stamp: { complete: true, coverageComplete: false, partition: null },
        update: {
          executedFiles: touchedFiles,
          fullyExecutedFiles: wholeTestFiles,
          presentFiles: [...touchedFiles, ...(this.runnerTestFiles ?? [])],
          results,
          testEdges,
        },
      })
      if (outcome._tag !== 'Committed') return null
      yield* writeVerificationSnapshot({
        executedTestIds: observations.map((observation) => observation.id),
        graph: outcome.graph,
        plan: run.plan,
        runner: this.runner,
        success: observations.every(
          (observation) => observation.state !== 'failed',
        ),
        target: verification,
      })
      yield* Effect.promise(() =>
        notifyRunComplete(
          this.options.replayAdapters,
          run.plan,
          { coverageReportDirectory: null, executedTestFiles: touchedFiles },
          console.warn,
        ),
      )
      return outcome.graph
    }).pipe(Effect.provide(EngineLive))
  }

  replayedResults(): CachedTestResult[] {
    return replayedResults(this.plan)
  }

  private preparedRun(): Prepared {
    if (this.prepared === null)
      throw new Error('TIA core has not been prepared')
    return this.prepared
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
