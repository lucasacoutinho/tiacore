import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
  Vitest,
} from 'vitest/node'

import type {
  CachedTestResult,
  TiaCoverageRecord,
  TiaTestEdge,
} from '../../core/runtime.ts'
import { runPromise } from '../../host/runtime.ts'
import { projectFingerprint } from '../../engine/baseline/fingerprint.ts'
import { writeCoverageReports } from '../../engine/coverage/report.ts'
import type { TiaCoverageCounterMap } from '../../engine/coverage/types.ts'
import { resolveFrameworkEdges } from '../../engine/edges/resolve.ts'
import { formatRunPlanDetails } from '../../engine/explain.ts'
import { projectRelative, trackedFile } from '../../engine/host-path.ts'
import { EngineLive } from '../../engine/layers.ts'
import { commitRun, type CommitSkipped } from '../../engine/lifecycle.ts'
import { notifyRunComplete, notifyRunStart } from '../../engine/replay.ts'
import { aggregateLocalPartitions } from '../../engine/state/partitions.ts'
import { writeVerificationSnapshot } from '../../engine/verification-snapshot.ts'
import { cachedTestCase } from './cached-test.ts'
import {
  directlyImportedAssetFiles,
  importedAssetFiles,
  type ModuleGraphLike,
} from './module-graph.ts'
import {
  TIA_META_KEY,
  TIA_REPLAY_META_KEY,
  TIA_TEST_META_KEY,
  type TiaModuleMeta,
  type TiaTestMeta,
} from './protocol.ts'
import type { TiaRuntime } from './state.ts'
import { errorMessage } from '../../wire/errors.ts'
import { isModuleFailureId, moduleFailureResult } from '../../core/runtime.ts'

/** The warning for a commit that left the stored graph untouched. */
function skippedCommitWarning(skipped: CommitSkipped): string {
  return Match.valueTags(skipped, {
    BaselineUnavailable: () =>
      'TIA graph was not updated because the Git baseline is unavailable.',
    Conflict: () =>
      'TIA graph was not updated because another process committed a conflicting graph.',
    FilesChanged: ({ changed }) =>
      `TIA graph was not updated because project files changed during the run.${
        changed.length === 0
          ? ''
          : ` Changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', …' : ''}.`
      }`,
    FingerprintChanged: () =>
      'TIA graph was not updated because project structure changed during the run.',
  })
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

interface ModuleEvidence {
  readonly concurrent: boolean
  readonly graph: ModuleGraphLike | undefined
  readonly shared: ReadonlySet<string>
}

/**
 * Collects what each worker observed and, at the end of a complete run,
 * commits the updated graph, reconstructs coverage and notifies replay
 * adapters. Any doubt about the run's evidence (interruption, unhandled
 * errors, missing metadata, files changed during the run, a conflicting
 * writer) leaves the stored graph untouched.
 */
export class TiaReporter implements Reporter {
  private readonly collectionCoverage = new Map<string, TiaCoverageRecord>()
  private readonly edges = new Map<string, string[]>()
  private readonly executedFiles = new Set<string>()
  /** Test files with at least one result replayed from the cache this run. */
  private readonly replayedFiles = new Set<string>()
  /** Per test file, what its module load and hooks touched outside test bodies. */
  private readonly collectionFiles = new Map<string, string[]>()
  private readonly results = new Map<string, CachedTestResult>()
  private readonly testEdges = new Map<string, TiaTestEdge>()
  private readonly testCoverage = new Map<string, TiaCoverageRecord>()
  /** What each finished module adds to its tests' edges, applied at run end. */
  private readonly modules = new Map<string, ModuleEvidence>()
  private incomplete = false
  private uninstrumentedCoverage = false
  private vitest: Vitest | null = null

  constructor(private readonly runtime: TiaRuntime) {}

  onInit(vitest: Vitest): void {
    this.vitest = vitest
  }

  async onTestRunStart(): Promise<void> {
    const plan = this.runtime.run?.plan
    if (plan === undefined) return
    if (this.runtime.coverage.enabled && this.runtime.coverage.clean) {
      rmSync(this.runtime.coverage.reportsDirectory, {
        force: true,
        recursive: true,
      })
    }
    if (this.runtime.options.log) {
      this.log(
        plan.mode === 'record'
          ? `TIA recording full-suite baseline (${plan.reason}).`
          : `TIA replay: ${plan.reason}; ${plural(plan.replayedTests, 'cached test result')}.`,
      )
      for (const line of formatRunPlanDetails(plan)) this.log(line)
    }
    await notifyRunStart(
      this.runtime.options.replayAdapters,
      plan,
      (message) => this.warn(message),
      (result) => this.notifyReplayReporters(result),
    )
  }

  onTestModuleEnd(module: TestModule): void {
    const testFile = projectRelative(this.runtime.root, module.moduleId)
    if (testFile === null || testFile === '') return
    const meta = module.meta()
    const value: TiaModuleMeta | undefined = meta[TIA_META_KEY]
    delete meta[TIA_META_KEY]
    if (value === undefined) {
      this.incomplete = true
      return
    }

    const dependencies = new Set<string>([testFile])
    const shared = new Set<string>([testFile])
    this.retainCoverage(
      this.collectionCoverage,
      testFile,
      value.collectionCoverage,
    )
    for (const file of value.files) {
      const dependency = trackedFile(
        this.runtime.root,
        file,
        this.runtime.boundary,
      )
      if (dependency !== null) dependencies.add(dependency)
    }
    for (const file of value.collectionFiles) {
      const dependency = trackedFile(
        this.runtime.root,
        file,
        this.runtime.boundary,
      )
      if (dependency !== null) shared.add(dependency)
    }
    const frameworkEdges = resolveFrameworkEdges(
      this.runtime.options.frameworkAdapters,
      {
        files: [...dependencies],
        root: this.runtime.root,
        testFile,
      },
    )
    if (!frameworkEdges.complete) this.incomplete = true
    for (const file of frameworkEdges.files) {
      dependencies.add(file)
      shared.add(file)
    }

    if (module.viteEnvironment !== undefined) {
      const graph = module.viteEnvironment.moduleGraph
      const sharedAssets = new Set(
        directlyImportedAssetFiles(
          graph,
          module.moduleId,
          this.runtime.root,
          this.runtime.boundary,
        ),
      )
      for (const collectionFile of value.collectionFiles) {
        for (const asset of importedAssetFiles(
          graph,
          collectionFile,
          this.runtime.root,
          this.runtime.boundary,
        )) {
          sharedAssets.add(asset)
        }
      }
      for (const asset of sharedAssets) {
        dependencies.add(asset)
        shared.add(asset)
      }
    }

    if (!value.concurrent) {
      this.collectionFiles.set(
        testFile,
        [...shared].filter((file) => file !== testFile).sort(),
      )
    }
    this.modules.set(testFile, {
      concurrent: value.concurrent,
      graph: module.viteEnvironment?.moduleGraph,
      shared,
    })
    this.executedFiles.add(testFile)
    this.edges.set(testFile, [...dependencies].sort())
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()
    if (result.state === 'pending') return
    const taskMeta = testCase.meta()
    const meta: TiaTestMeta | undefined = taskMeta[TIA_TEST_META_KEY]
    delete taskMeta[TIA_TEST_META_KEY]
    const file = projectRelative(this.runtime.root, testCase.module.moduleId)
    if (file === null || file === '') return
    if (taskMeta[TIA_REPLAY_META_KEY] === true) {
      this.replayedFiles.add(file)
      return
    }

    const diagnostic = testCase.diagnostic()
    this.results.set(testCase.id, {
      ...(diagnostic === undefined ? {} : { duration: diagnostic.duration }),
      file,
      fullName: testCase.fullName,
      id: testCase.id,
      state: result.state,
    })
    if (meta === undefined) {
      if (result.state !== 'skipped') this.incomplete = true
      return
    }
    const dependencies = new Set<string>([file])
    for (const dependencyFile of meta.files) {
      const dependency = trackedFile(
        this.runtime.root,
        dependencyFile,
        this.runtime.boundary,
      )
      if (dependency !== null) dependencies.add(dependency)
    }
    const frameworkEdges = resolveFrameworkEdges(
      this.runtime.options.frameworkAdapters,
      {
        files: [...dependencies],
        root: this.runtime.root,
        testFile: file,
      },
    )
    if (!frameworkEdges.complete) this.incomplete = true
    for (const dependency of frameworkEdges.files) dependencies.add(dependency)
    this.testEdges.set(testCase.id, { file, files: [...dependencies].sort() })
    this.retainCoverage(this.testCoverage, testCase.id, meta.coverage)
  }

  /**
   * Gives each test the evidence its module shares: assets its own
   * dependencies import, and the module's collection files. Tests of a module
   * recorded in concurrent mode lose their per-test edges and fall back to the
   * whole file. Done at run end, because Vitest may report a test case after
   * its module.
   */
  private mergeModuleEvidence(): void {
    for (const [id, edge] of this.testEdges) {
      const evidence = this.modules.get(edge.file)
      if (evidence === undefined) continue
      if (evidence.concurrent) {
        this.testEdges.delete(id)
        this.testCoverage.delete(id)
        continue
      }
      const files = new Set([...edge.files, ...evidence.shared])
      if (evidence.graph !== undefined) {
        const moduleEdges = new Set(this.edges.get(edge.file))
        for (const dependency of edge.files) {
          if (dependency === edge.file) continue
          for (const asset of importedAssetFiles(
            evidence.graph,
            resolve(this.runtime.root, dependency),
            this.runtime.root,
            this.runtime.boundary,
          )) {
            files.add(asset)
            moduleEdges.add(asset)
          }
        }
        this.edges.set(edge.file, [...moduleEdges].sort())
      }
      this.testEdges.set(id, { file: edge.file, files: [...files].sort() })
    }
    this.modules.clear()
  }

  private retainCoverage(
    target: Map<string, TiaCoverageRecord>,
    key: string,
    counters: TiaCoverageCounterMap,
  ): void {
    const unknown = this.runtime.coverageTemplates.unknownFiles(
      this.runtime.root,
      counters,
      this.runtime.boundary,
    )
    if (unknown.length > 0 && !this.uninstrumentedCoverage) {
      this.uninstrumentedCoverage = true
      this.incomplete = true
      this.warn(
        `TIA cannot reconstruct coverage for ${unknown[0]} because tiacore did not instrument it in this run, for example when Vitest's experimental.fsModuleCache served a cached transform.`,
      )
    }
    target.set(
      key,
      this.runtime.coverageTemplates.record(
        this.runtime.root,
        counters,
        this.runtime.boundary,
      ),
    )
  }

  async onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): Promise<void> {
    const plan = this.runtime.run?.plan
    if (plan === undefined) return
    if (reason === 'interrupted') {
      this.warn('TIA graph was not updated because the run was interrupted.')
      return
    }
    if (unhandledErrors.length > 0) {
      this.warn(
        'TIA graph was not updated because Vitest reported an unhandled error.',
      )
      return
    }
    if (this.incomplete) {
      this.warn(
        'TIA graph was not updated because dependency metadata was incomplete.',
      )
      return
    }
    this.mergeModuleEvidence()
    this.recordModuleFailures(modules)
    const recordComplete =
      plan.mode !== 'record' ||
      this.runtime.partition !== null ||
      (await this.recordIncludesEveryConfiguredTestFile(modules))
    const failedRun = modules.some((module) => !module.ok())
    const shouldReportCoverage = await runPromise(
      this.commit(recordComplete, failedRun).pipe(
        Effect.withSpan('tia.vitest.commit'),
        Effect.provide(EngineLive),
      ),
    )
    if (shouldReportCoverage === undefined) return

    await notifyRunComplete(
      this.runtime.options.replayAdapters,
      plan,
      {
        coverageReportDirectory: shouldReportCoverage
          ? this.runtime.coverage.reportsDirectory
          : null,
        executedTestFiles: this.executedFiles,
      },
      (message) => this.warn(message),
    )
  }

  /** Commits the run's graph; undefined when it was not committed, else whether coverage was reported. */
  private commit(recordComplete: boolean, failedRun: boolean) {
    return Effect.gen({ self: this }, function* () {
      const runtime = this.runtime
      const run = runtime.run
      if (run === null) return undefined
      const plan = run.plan
      const outcome = yield* commitRun({
        fingerprint: yield* projectFingerprint(
          runtime.root,
          runtime.options,
          runtime.structuralFiles,
        ),
        run,
        stamp: {
          complete: runtime.partition === null && recordComplete,
          // A replay keeps the evidence of the graph it extends.
          coverageComplete:
            plan.mode === 'record'
              ? recordComplete
              : (plan.graph?.coverageComplete ?? false),
          partition: runtime.partition,
        },
        update: {
          collectionCoverage: this.collectionCoverage,
          collectionFiles: this.collectionFiles,
          coverageMaps: runtime.coverageTemplates.maps([
            ...this.collectionCoverage.values(),
            ...this.testCoverage.values(),
          ]),
          executedFiles: this.executedFiles,
          fallbackEdges: this.edges,
          // A file is fully executed when none of its tests was replayed; the
          // update then replaces its evidence instead of extending it.
          fullyExecutedFiles:
            plan.mode === 'record'
              ? this.executedFiles
              : [...this.executedFiles].filter(
                  (file) => !this.replayedFiles.has(file),
                ),
          // Vitest collected these files this run, so they exist.
          presentFiles: [...this.executedFiles, ...this.replayedFiles],
          results: this.results,
          testCoverage: this.testCoverage,
          testEdges: this.testEdges,
        },
      })
      if (outcome._tag !== 'Committed') {
        this.warn(skippedCommitWarning(outcome))
        return undefined
      }
      const saved =
        runtime.partition === null
          ? outcome.graph
          : ((yield* aggregateLocalPartitions(
              runtime.options.cacheDir,
              runtime.partition,
            )) ?? outcome.graph)
      if (!recordComplete) {
        this.warn(
          'TIA saved an incomplete graph because Vitest did not execute every configured test file.',
        )
      }

      const coverageReady = runtime.partition === null || saved.complete
      const shouldReportCoverage =
        runtime.coverage.enabled &&
        coverageReady &&
        (!failedRun || runtime.coverage.reportOnFailure)
      if (shouldReportCoverage) {
        const canCheckThresholds = saved.complete && saved.coverageComplete
        const report = yield* writeCoverageReports(
          saved,
          runtime.root,
          canCheckThresholds
            ? runtime.coverage
            : { ...runtime.coverage, thresholds: null },
        )
        if (runtime.coverage.thresholds !== null && !canCheckThresholds) {
          this.warn(
            'TIA coverage thresholds were deferred because this graph is a partial shard.',
          )
        }
        if (runtime.coverage.thresholds?.autoUpdate) {
          this.warn(
            'TIA enforced coverage thresholds but did not rewrite the Vitest config for thresholds.autoUpdate.',
          )
        }
        for (const warning of report.warnings) this.warn(warning)
        for (const failure of report.thresholdFailures) {
          process.exitCode = 1
          this.error(failure.message)
        }
        if (runtime.options.log) {
          this.log(
            `TIA coverage reconstructed: ${plural(report.files, 'source file')} in ${runtime.coverage.reportsDirectory}.`,
          )
        }
      }
      if (
        runtime.coverage.enabled &&
        !coverageReady &&
        runtime.coverage.thresholds !== null
      ) {
        this.warn(
          'TIA coverage thresholds were deferred because this graph is a partial shard.',
        )
      }
      if (runtime.options.log) {
        const replayed = plan.mode === 'replay' ? plan.replayedTests : 0
        this.log(
          `TIA graph saved: ${plural(this.executedFiles.size, 'executed file')}, ${plural(replayed, 'replayed result')}.`,
        )
      }
      yield* writeVerificationSnapshot({
        executedTestIds: this.results.keys(),
        graph: saved,
        plan,
        runner: `vitest:${projectRelative(runtime.root, runtime.options.cacheDir) ?? runtime.options.cacheDir}`,
        success: !failedRun,
        target: runtime.verification,
      })
      return shouldReportCoverage
    })
  }

  private async recordIncludesEveryConfiguredTestFile(
    modules: ReadonlyArray<TestModule>,
  ): Promise<boolean> {
    if (this.vitest === null) return false
    try {
      const expected = new Set<string>()
      for (const project of this.vitest.projects) {
        const files = await project.globTestFiles()
        for (const file of files.testFiles) {
          const relative = projectRelative(this.runtime.root, file)
          if (relative !== null && relative !== '') expected.add(relative)
        }
      }
      const observed = new Set(
        modules
          .map((module) => projectRelative(this.runtime.root, module.moduleId))
          .filter((file): file is string => file !== null && file !== ''),
      )
      return [...expected].every((file) => observed.has(file))
    } catch {
      return false
    }
  }

  private async notifyReplayReporters(result: CachedTestResult): Promise<void> {
    if (
      this.vitest === null ||
      this.runtime.options.replayReporters.length === 0
    )
      return
    const testCase = cachedTestCase(this.vitest, this.runtime.root, result)
    for (const reporter of this.runtime.options.replayReporters) {
      for (const method of ['onTestCaseReady', 'onTestCaseResult'] as const) {
        const handler = reporter[method] as
          | ((testCase: TestCase) => Promise<void> | void)
          | undefined
        if (handler === undefined) continue
        try {
          await handler.call(reporter, testCase)
        } catch (error) {
          this.warn(
            `TIA replay reporter ${method} failed: ${errorMessage(error)}`,
          )
        }
      }
    }
  }

  private recordModuleFailures(modules: ReadonlyArray<TestModule>): void {
    for (const module of modules) {
      if (module.state() !== 'failed') continue
      const file = projectRelative(this.runtime.root, module.moduleId)
      if (file === null || file === '') continue
      const hasFailedTestCase = [...this.results.values()].some(
        (result) =>
          result.file === file &&
          result.state === 'failed' &&
          !isModuleFailureId(result.id),
      )
      if (hasFailedTestCase) continue
      const failure = moduleFailureResult(file)
      this.results.set(failure.id, failure)
    }
  }

  private log(message: string): void {
    if (this.vitest !== null) this.vitest.logger.log(`\n ${message}`)
    else console.log(message)
  }

  private error(message: string): void {
    if (this.vitest !== null) this.vitest.logger.error(message)
    else console.error(message)
  }

  private warn(message: string): void {
    if (this.vitest !== null) this.vitest.logger.warn(message)
    else console.warn(message)
  }
}
