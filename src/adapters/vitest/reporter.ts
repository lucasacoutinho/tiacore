import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  Reporter,
  TestCase,
  TestModule,
  TestRunEndReason,
  Vitest,
} from 'vitest/node'

import {
  TIA_META_KEY,
  TIA_REPLAY_META_KEY,
  TIA_TEST_META_KEY,
} from '../../shared/constants.js'
import { snapshotRuntimeProject } from '../../engine/lifecycle.js'
import { formatRunPlanDetails } from '../../engine/explain.js'
import {
  portableCoverageMap,
  writeCoverageReports,
} from '../../integrations/coverage/report.js'
import { aggregateLocalPartitions } from '../../engine/state/partitions.js'
import { resolveFrameworkEdges } from '../../integrations/edges/resolve.js'
import {
  directlyImportedAssetFiles,
  importedAssetFiles,
} from './module-graph.js'
import { commitGraph } from '../../engine/state/store.js'
import { updateGraph } from '../../engine/state/update.js'
import { projectRelative } from '../../shared/paths.js'
import {
  notifyReplayAdapters,
  replayedResults,
  replayRunEvent,
} from '../../engine/replay/index.js'
import { writeVerificationSnapshot } from '../../verification/snapshot.js'
import { cachedTestCase } from './cached-test.js'
import type {
  Baseline,
  CachedTestResult,
  TiaCoverageMap,
  TiaModuleMeta,
  TiaRuntime,
  TiaTestEdge,
  TiaTestMeta,
} from '../../shared/types.js'

function baselineDifferences(
  before: Baseline,
  after: Baseline,
): string[] {
  return [
    ...new Set([
      ...Object.keys(before.workingTree),
      ...Object.keys(after.workingTree),
    ]),
  ]
    .filter(
      (file) =>
        before.workingTree[file] !== after.workingTree[file],
    )
    .sort()
}

export class TiaReporter implements Reporter {
  private readonly collectionCoverage = new Map<string, TiaCoverageMap>()
  private readonly edges = new Map<string, string[]>()
  private readonly executedFiles = new Set<string>()
  private readonly results = new Map<string, CachedTestResult>()
  private readonly testEdges = new Map<string, TiaTestEdge>()
  private readonly testCoverage = new Map<string, TiaCoverageMap>()
  private incomplete = false
  private vitest: Vitest | null = null

  constructor(private readonly runtime: TiaRuntime) {}

  onInit(vitest: Vitest): void {
    this.vitest = vitest
  }

  async onTestRunStart(): Promise<void> {
    const plan = this.runtime.plan

    if (plan === null) {
      return
    }

    if (
      this.runtime.coverage.enabled &&
      this.runtime.coverage.clean
    ) {
      rmSync(this.runtime.coverage.reportsDirectory, {
        force: true,
        recursive: true,
      })
    }

    if (this.runtime.options.log) {
      if (plan.mode === 'record') {
        this.log(`TIA recording full-suite baseline (${plan.reason}).`)
      } else {
        this.log(
          `TIA replay: ${plan.reason}; ${plan.replayedTests} cached test result${
            plan.replayedTests === 1 ? '' : 's'
          }.`,
        )
      }
      for (const line of formatRunPlanDetails(plan)) {
        this.log(line)
      }
    }

    await notifyReplayAdapters(
      this.runtime.options.replayAdapters,
      'onRunStart',
      replayRunEvent(plan),
      (message) => this.warn(message),
    )
    for (const result of replayedResults(plan)) {
      await notifyReplayAdapters(
        this.runtime.options.replayAdapters,
        'onTestReplayed',
        { result: structuredClone(result) },
        (message) => this.warn(message),
      )
      await this.notifyReplayReporters(result)
    }
  }

  onTestModuleEnd(module: TestModule): void {
    const testFile = projectRelative(this.runtime.root, module.moduleId)

    if (testFile === null || testFile === '') {
      return
    }

    const value = module.meta()[TIA_META_KEY] as TiaModuleMeta | undefined

    if (value === undefined) {
      this.incomplete = true
      return
    }

    const dependencies = new Set<string>([testFile])
    const sharedTestDependencies = new Set<string>([testFile])
    this.collectionCoverage.set(
      testFile,
      portableCoverageMap(this.runtime.root, value.collectionCoverage),
    )

    for (const file of value.files) {
      const dependency = projectRelative(this.runtime.root, file)
      if (dependency !== null && dependency !== '') {
        dependencies.add(dependency)
      }
    }

    for (const file of value.collectionFiles) {
      const dependency = projectRelative(this.runtime.root, file)
      if (dependency !== null && dependency !== '') {
        sharedTestDependencies.add(dependency)
      }
    }
    const moduleFrameworkEdges = resolveFrameworkEdges(
      this.runtime.options.frameworkAdapters,
      {
        files: [...dependencies],
        root: this.runtime.root,
        testFile,
      },
    )
    if (!moduleFrameworkEdges.complete) {
      this.incomplete = true
    }
    for (const file of moduleFrameworkEdges.files) {
      dependencies.add(file)
      sharedTestDependencies.add(file)
    }

    if (module.viteEnvironment !== undefined) {
      const moduleGraph = module.viteEnvironment.moduleGraph
      const sharedAssets = new Set(
        directlyImportedAssetFiles(
          moduleGraph,
          module.moduleId,
          this.runtime.root,
        ),
      )

      for (const collectionFile of value.collectionFiles) {
        for (const asset of importedAssetFiles(
          moduleGraph,
          collectionFile,
          this.runtime.root,
        )) {
          sharedAssets.add(asset)
        }
      }

      for (const asset of sharedAssets) {
        dependencies.add(asset)
        sharedTestDependencies.add(asset)
      }

      for (const [id, edge] of this.testEdges) {
        if (edge.file !== testFile) {
          continue
        }

        const caseAssets = new Set<string>()
        for (const dependency of edge.files) {
          if (dependency === testFile) {
            continue
          }

          for (const asset of importedAssetFiles(
            moduleGraph,
            resolve(this.runtime.root, dependency),
            this.runtime.root,
          )) {
            caseAssets.add(asset)
            dependencies.add(asset)
          }
        }

        this.testEdges.set(id, {
          file: edge.file,
          files: [...new Set([...edge.files, ...caseAssets])].sort(),
        })
      }
    }

    for (const [id, edge] of this.testEdges) {
      if (edge.file === testFile) {
        if (value.concurrent) {
          this.testEdges.delete(id)
          this.testCoverage.delete(id)
        } else {
          this.testEdges.set(id, {
            file: edge.file,
            files: [
              ...new Set([...edge.files, ...sharedTestDependencies]),
            ].sort(),
          })
        }
      }
    }

    this.executedFiles.add(testFile)
    this.edges.set(testFile, [...dependencies].sort())
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()

    if (result.state === 'pending') {
      return
    }

    if (testCase.meta()[TIA_REPLAY_META_KEY] === true) {
      return
    }

    const file = projectRelative(this.runtime.root, testCase.module.moduleId)
    if (file === null || file === '') {
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

    const meta = testCase.meta()[TIA_TEST_META_KEY] as TiaTestMeta | undefined
    if (meta === undefined) {
      if (result.state !== 'skipped') {
        this.incomplete = true
      }
      return
    }

    const dependencies = new Set<string>([file])
    for (const dependencyFile of meta.files) {
      const dependency = projectRelative(this.runtime.root, dependencyFile)
      if (dependency !== null && dependency !== '') {
        dependencies.add(dependency)
      }
    }
    const frameworkEdges = resolveFrameworkEdges(
      this.runtime.options.frameworkAdapters,
      {
        files: [...dependencies],
        root: this.runtime.root,
        testFile: file,
      },
    )
    if (!frameworkEdges.complete) {
      this.incomplete = true
    }
    for (const dependency of frameworkEdges.files) {
      dependencies.add(dependency)
    }
    this.testEdges.set(testCase.id, {
      file,
      files: [...dependencies].sort(),
    })
    this.testCoverage.set(
      testCase.id,
      portableCoverageMap(this.runtime.root, meta.coverage),
    )
  }

  async onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): Promise<void> {
    const plan = this.runtime.plan
    if (plan === null) {
      return
    }

    if (reason === 'interrupted') {
      this.warn('TIA graph was not updated because the run was interrupted.')
      return
    }

    if (unhandledErrors.length > 0) {
      this.warn('TIA graph was not updated because Vitest reported an unhandled error.')
      return
    }

    if (this.incomplete) {
      this.warn('TIA graph was not updated because dependency metadata was incomplete.')
      return
    }

    this.recordModuleFailures(modules)

    const snapshot = snapshotRuntimeProject({
      ignoredPrefixes: this.runtime.ignoredPrefixes,
      options: this.runtime.options,
      root: this.runtime.root,
      structuralFiles: this.runtime.structuralFiles,
    })
    const fingerprint = snapshot.fingerprint

    if (fingerprint !== this.runtime.fingerprintAtStart) {
      this.warn('TIA graph was not updated because project structure changed during the run.')
      return
    }

    const baseline = snapshot.baseline

    if (baseline === null) {
      this.warn('TIA graph was not updated because the Git baseline is unavailable.')
      return
    }

    if (
      this.runtime.baselineAtStart === null ||
      JSON.stringify(baseline) !== JSON.stringify(this.runtime.baselineAtStart)
    ) {
      const changed =
        this.runtime.baselineAtStart === null
          ? []
          : baselineDifferences(
              this.runtime.baselineAtStart,
              baseline,
            )
      this.warn(
        `TIA graph was not updated because project files changed during the run.${
          changed.length === 0
            ? ''
            : ` Changed: ${changed.slice(0, 10).join(', ')}${
                changed.length > 10 ? ', …' : ''
              }.`
        }`,
      )
      return
    }

    const recordComplete =
      plan.mode !== 'record' ||
      this.runtime.partition !== null ||
      await this.recordIncludesEveryConfiguredTestFile(modules)
    const graph = updateGraph({
      collectionCoverage: this.collectionCoverage,
      executedFiles: this.executedFiles,
      fallbackEdges: this.edges,
      fullyExecutedFiles:
        plan.mode === 'record'
          ? this.executedFiles
          : [...this.executedFiles].filter((file) =>
              plan.wholeTestFiles.includes(file),
            ),
      previous: plan.mode === 'record' ? null : plan.graph,
      results: this.results,
      root: this.runtime.root,
      testCoverage: this.testCoverage,
      testEdges: this.testEdges,
    })
    graph.baseline = baseline
    graph.complete =
      this.runtime.partition === null && recordComplete
    graph.coverageComplete =
      plan.mode === 'record' ? recordComplete : graph.coverageComplete
    graph.fingerprint = fingerprint
    if (this.runtime.partition === null) {
      delete graph.partition
    } else {
      graph.partition = structuredClone(this.runtime.partition)
    }
    graph.updatedAt = new Date().toISOString()

    const committed = await commitGraph(
      this.runtime.writeCacheDir,
      {
        expected: this.runtime.graphAtStart,
        expectedDigest: this.runtime.graphDigestAtStart,
        graph,
      },
    )
    if (committed.status === 'conflict' || committed.graph === null) {
      this.warn(
        'TIA graph was not updated because another process committed a conflicting graph.',
      )
      return
    }
    let savedGraph = committed.graph
    if (this.runtime.partition !== null) {
      savedGraph =
        await aggregateLocalPartitions(
          this.runtime.options.cacheDir,
          this.runtime.partition,
        ) ?? savedGraph
    }

    if (!recordComplete) {
      this.warn(
        'TIA saved an incomplete graph because Vitest did not execute every configured test file.',
      )
    }

    const coverageReady =
      this.runtime.partition === null || savedGraph.complete
    const failedRun = modules.some((module) => !module.ok())
    const shouldReportCoverage =
      this.runtime.coverage.enabled &&
      coverageReady &&
      (!failedRun || this.runtime.coverage.reportOnFailure)
    if (shouldReportCoverage) {
      const canCheckThresholds =
        savedGraph.complete && savedGraph.coverageComplete
      const report = writeCoverageReports(
        savedGraph,
        this.runtime.root,
        canCheckThresholds
          ? this.runtime.coverage
          : {
              ...this.runtime.coverage,
              thresholds: null,
            },
      )
      if (
        this.runtime.coverage.thresholds !== null &&
        !canCheckThresholds
      ) {
        this.warn(
          'TIA coverage thresholds were deferred because this graph is a partial shard.',
        )
      }
      if (
        this.runtime.coverage.thresholds?.autoUpdate
      ) {
        this.warn(
          'TIA enforced coverage thresholds but did not rewrite the Vitest config for thresholds.autoUpdate.',
        )
      }
      for (const warning of report.warnings) {
        this.warn(warning)
      }
      for (const failure of report.thresholdFailures) {
        process.exitCode = 1
        this.error(failure.message)
      }
      if (this.runtime.options.log) {
        this.log(
          `TIA coverage reconstructed: ${report.files} source file${
            report.files === 1 ? '' : 's'
          } in ${this.runtime.coverage.reportsDirectory}.`,
        )
      }
    }
    if (
      this.runtime.coverage.enabled &&
      !coverageReady &&
      this.runtime.coverage.thresholds !== null
    ) {
      this.warn(
        'TIA coverage thresholds were deferred because this graph is a partial shard.',
      )
    }

    if (this.runtime.options.log) {
      const replayed = plan.mode === 'replay' ? plan.replayedTests : 0
      this.log(
        `TIA graph saved: ${this.executedFiles.size} executed file${
          this.executedFiles.size === 1 ? '' : 's'
        }, ${replayed} replayed result${replayed === 1 ? '' : 's'}.`,
      )
    }

    await writeVerificationSnapshot({
      executedTestIds: this.results.keys(),
      graph: savedGraph,
      plan,
      runner: `vitest:${
        projectRelative(
          this.runtime.root,
          this.runtime.options.cacheDir,
        ) ?? this.runtime.options.cacheDir
      }`,
      success: !failedRun,
    })

    await notifyReplayAdapters(
      this.runtime.options.replayAdapters,
      'onRunComplete',
      {
        ...replayRunEvent(plan),
        coverageReportDirectory:
          shouldReportCoverage
          ? this.runtime.coverage.reportsDirectory
          : null,
        executedTestFiles: [...this.executedFiles].sort(),
      },
      (message) => this.warn(message),
    )
  }

  private async recordIncludesEveryConfiguredTestFile(
    modules: ReadonlyArray<TestModule>,
  ): Promise<boolean> {
    if (this.vitest === null) {
      return false
    }

    try {
      const expected = new Set<string>()
      for (const project of this.vitest.projects) {
        const files = await project.globTestFiles()
        for (const file of files.testFiles) {
          const relative = projectRelative(this.runtime.root, file)
          if (relative !== null && relative !== '') {
            expected.add(relative)
          }
        }
      }

      const observed = new Set(
        modules
          .map((module) =>
            projectRelative(this.runtime.root, module.moduleId),
          )
          .filter(
            (file): file is string =>
              file !== null && file !== '',
          ),
      )
      return [...expected].every((file) => observed.has(file))
    } catch {
      return false
    }
  }

  private async notifyReplayReporters(
    result: CachedTestResult,
  ): Promise<void> {
    if (
      this.vitest === null ||
      this.runtime.options.replayReporters.length === 0
    ) {
      return
    }

    const testCase = cachedTestCase(
      this.vitest,
      this.runtime.root,
      result,
    )
    for (const reporter of this.runtime.options.replayReporters) {
      for (const method of [
        'onTestCaseReady',
        'onTestCaseResult',
      ] as const) {
        const handler = reporter[method] as
          | ((testCase: TestCase) => Promise<void> | void)
          | undefined
        if (handler === undefined) {
          continue
        }

        try {
          await handler.call(reporter, testCase)
        } catch (error) {
          this.warn(
            `TIA replay reporter ${method} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    }
  }

  private recordModuleFailures(modules: ReadonlyArray<TestModule>): void {
    for (const module of modules) {
      if (module.state() !== 'failed') {
        continue
      }

      const file = projectRelative(this.runtime.root, module.moduleId)
      if (file === null || file === '') {
        continue
      }

      const hasFailedTestCase = [...this.results.values()].some(
        (result) =>
          result.file === file &&
          result.state === 'failed' &&
          !result.id.startsWith('module:'),
      )
      if (hasFailedTestCase) {
        continue
      }

      const id = `module:${file}`
      this.results.set(id, {
        file,
        fullName: `${file} (module failure)`,
        id,
        state: 'failed',
      })
    }
  }

  private log(message: string): void {
    if (this.vitest !== null) {
      this.vitest.logger.log(`\n ${message}`)
      return
    }

    console.log(message)
  }

  private error(message: string): void {
    if (this.vitest !== null) {
      this.vitest.logger.error(message)
      return
    }

    console.error(message)
  }

  private warn(message: string): void {
    if (this.vitest !== null) {
      this.vitest.logger.warn(message)
      return
    }

    console.warn(message)
  }
}
