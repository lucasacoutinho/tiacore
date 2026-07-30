import type { Instrumenter } from 'istanbul-lib-instrument'
import type { FileCoverageData } from 'istanbul-lib-coverage'

export type TiaCoverageReporter =
  | 'clover'
  | 'cobertura'
  | 'html'
  | 'html-spa'
  | 'json'
  | 'json-summary'
  | 'lcov'
  | 'lcovonly'
  | 'text'
  | 'text-lcov'
  | 'text-summary'
  | (string & {})

export type TiaCoverageReporterConfig =
  | TiaCoverageReporter
  | [
      TiaCoverageReporter,
      Record<string, unknown>?,
    ]

export interface TiaCoverageThresholdValues {
  /**
   * Set all four metrics to 100%.
   */
  100?: boolean
  branches?: number
  functions?: number
  lines?: number
  statements?: number
}

export interface TiaCoverageThresholds
  extends TiaCoverageThresholdValues {
  /**
   * Accepted for compatibility, but tiacore never rewrites the Vitest config.
   */
  autoUpdate?: boolean | ((newThreshold: number) => number)
  /**
   * Check every file independently instead of the merged summary.
   */
  perFile?: boolean
  [key: string]:
    | boolean
    | number
    | ((newThreshold: number) => number)
    | TiaCoverageThresholdValues
    | undefined
}

export interface TiaCoverageWatermarks {
  branches?: [number, number]
  functions?: [number, number]
  lines?: [number, number]
  statements?: [number, number]
}

export interface TiaCoverageOptions {
  /**
   * Include unexecuted matching source files in the report with zero hits.
   * When omitted, only executed files are reported.
   */
  include?: string[]
  /**
   * Files removed from both executed and explicitly included coverage.
   *
   * @default []
   */
  exclude?: string[]
  /**
   * Delete the reports directory before the run.
   *
   * @default true
   */
  clean?: boolean
  /**
   * Delete old reports before a watch rerun. TIA currently delegates watch
   * mode to Vitest, so this applies when Vitest owns that rerun.
   *
   * @default true
   */
  cleanOnRerun?: boolean
  /**
   * Output directory, relative to the project root unless absolute.
   *
   * @default "coverage"
   */
  reportsDirectory?: string
  /**
   * Istanbul reports to generate from the complete executed plus cached map.
   *
   * @default ["text", "html", "json"]
   */
  reporters?: TiaCoverageReporterConfig[]
  /**
   * Generate reports even if one or more tests failed.
   *
   * @default false
   */
  reportOnFailure?: boolean
  /**
   * Hide files whose statement, branch, and function coverage is 100%.
   *
   * @default false
   */
  skipFull?: boolean
  /**
   * Istanbul coverage thresholds applied to the reconstructed full-suite map.
   * Positive values are minimum percentages and negative values are maximum
   * uncovered counts. Vitest-compatible global, per-file, `100`, and glob
   * threshold sets are supported.
   */
  thresholds?: TiaCoverageThresholds
  /**
   * Low/high boundaries used by Istanbul reporters.
   */
  watermarks?: TiaCoverageWatermarks
}

export interface TiaGitHubActionsOptions {
  /**
   * GitHub API base URL. This also supports GitHub Enterprise API endpoints.
   *
   * @default "https://api.github.com"
   */
  apiUrl?: string
  /**
   * Artifact name or picomatch pattern uploaded by `actions/upload-artifact`.
   *
   * @default "tiacore"
   */
  artifactName?: string
  /**
   * Only consider artifacts produced from this branch.
   */
  branch?: string
  /**
   * Maximum number of recent matching artifacts to inspect.
   *
   * @default 20
   */
  maxArtifacts?: number
  /**
   * Repository in `owner/name` form.
   *
   * @default process.env.GITHUB_REPOSITORY
   */
  repository?: string
  /**
   * Restrict discovery to one workflow run ID.
   */
  runId?: number | string
  /**
   * Environment variable holding a token with Actions read permission.
   *
   * @default "GITHUB_TOKEN"
   */
  tokenEnv?: string
}

export interface TiaFilesystemArtifactOptions {
  /**
   * Fallback group for legacy partition graphs without embedded group
   * metadata.
   */
  group?: string
  /**
   * Project-relative graph files or directories recursively containing
   * `graph.json` files downloaded by any CI artifact mechanism.
   *
   * @default [".tia-artifacts"]
   */
  paths?: string[]
}

export interface TiaArtifactProviderContext {
  fingerprint: string
  root?: string
  runner?: string
}

export interface TiaArtifactCandidate {
  graph: string | unknown
  /**
   * Identifies fragments produced by the same CI run or aggregation batch.
   * Partitions from different groups are never combined.
   */
  group?: number | string
  id: number | string
}

export interface TiaArtifactProvider {
  /**
   * Human-readable provider name used in diagnostics.
   */
  name: string
  /**
   * Return the best available candidate. Shared tiacore code still validates its
   * schema, completeness, and structural fingerprint before persisting it.
   */
  load(
    context: TiaArtifactProviderContext,
  ):
    | Promise<TiaArtifactCandidate | TiaArtifactCandidate[] | null>
    | TiaArtifactCandidate
    | TiaArtifactCandidate[]
    | null
}

export type TiaArtifactSource =
  | TiaArtifactProvider
  | ({ provider: 'filesystem' } & TiaFilesystemArtifactOptions)
  | ({ provider: 'github-actions' } & TiaGitHubActionsOptions)

export interface TiaReplayRunEvent {
  affectedTestIds: string[]
  affectedTests: string[]
  changedFiles: string[]
  mode: RunMode
  reason: string
  replayedTests: number
  wholeTestFiles: string[]
}

export interface TiaReplayedTestEvent {
  result: CachedTestResult
}

export interface TiaReplayCompleteEvent extends TiaReplayRunEvent {
  coverageReportDirectory: string | null
  executedTestFiles: string[]
}

export interface TiaReplayAdapter {
  onRunComplete?(event: TiaReplayCompleteEvent): Promise<void> | void
  onRunStart?(event: TiaReplayRunEvent): Promise<void> | void
  onTestReplayed?(event: TiaReplayedTestEvent): Promise<void> | void
}

export interface TiaReplayReporter {
  onTestCaseReady?: (...arguments_: never[]) => unknown
  onTestCaseResult?: (...arguments_: never[]) => unknown
}

export interface TiaFrameworkEdgeContext {
  /**
   * Project-relative runtime dependencies already observed for this test.
   */
  files: string[]
  root: string
  testFile: string
}

export interface TiaFrameworkEdgeAdapter {
  /**
   * Stable identifier included in the project fingerprint.
   */
  name: string
  /**
   * Optional version/config key. Change it when adapter semantics change.
   */
  fingerprint?: string
  /**
   * Return additional project-relative or absolute dependency paths.
   */
  resolve(context: TiaFrameworkEdgeContext): string[]
}

export interface TiaDatabaseEdgeOptions {
  /**
   * SQL migration files whose referenced tables should be linked to tests.
   */
  migrations?: string[]
  /**
   * ORM schema files linked to every test with a detected database query.
   */
  schemas?: string[]
}

export interface TiaViewEdgeOptions {
  /**
   * Template extensions, with or without a leading dot.
   */
  extensions?: string[]
  /**
   * Directories searched for logical view names such as `users/show`.
   */
  roots?: string[]
}

export interface TiaSubprocessEdgeMapping {
  /**
   * Project-relative files or glob patterns owned by the subprocess.
   */
  files: string[]
  /**
   * Test-file globs whose processes execute those files.
   */
  tests: string[]
}

export interface TiaSubprocessEdgeOptions {
  /**
   * Explicit, reviewable mappings for process boundaries that cannot share
   * runtime instrumentation with the parent test worker.
   */
  mappings: TiaSubprocessEdgeMapping[]
}

export interface TiaFrameworkOptions {
  adapters?: TiaFrameworkEdgeAdapter | TiaFrameworkEdgeAdapter[]
  database?: boolean | TiaDatabaseEdgeOptions
  subprocess?: TiaSubprocessEdgeOptions
  views?: boolean | TiaViewEdgeOptions
}

export interface TiaOptions {
  /**
   * Enable TIA. By default it is enabled for `vitest run`, `--run`, and CI.
   */
  enabled?: boolean
  /**
   * Directory containing the portable graph artifact, relative to the project
   * root unless absolute.
   *
   * @default ".tia"
   */
  cacheDir?: string
  /**
   * Stable identity for one set of Vitest `--shard` processes. It can also be
   * supplied through `TIA_SHARD_GROUP`. Different groups are never combined.
   */
  shardGroup?: string
  /**
   * Source files eligible for runtime instrumentation.
   */
  include?: string[]
  /**
   * Files excluded from runtime instrumentation.
   */
  exclude?: string[]
  /**
   * Changed files that may be ignored when they have no recorded dependency
   * edge. Structural and test files are never ignored by this option.
   *
   * @default []
   */
  ignoreChanges?: string[]
  /**
   * Rebuild the graph even when a compatible cache exists.
   */
  fresh?: boolean
  /**
   * What to do when any changed file has no recorded dependency edge.
   *
   * @default "full"
   */
  onUnknownChange?: 'full' | 'ignore'
  /**
   * Print TIA decisions and the replay recap.
   *
   * @default true
   */
  log?: boolean
  /**
   * Generate full-suite Istanbul reports on normal TIA runs. Passing
   * `--coverage` also enables this automatically and uses Vitest's configured
   * report directory and supported reporter names.
   */
  coverage?: boolean | TiaCoverageOptions
  /**
   * Restore a compatible graph from one or more artifact providers when the
   * local graph is absent or incompatible. External discovery is opt-in.
   */
  artifacts?: TiaArtifactSource | TiaArtifactSource[]
  /**
   * Opt-in framework edges for runtime-selected templates, database schemas,
   * migrations, and custom integrations.
   */
  frameworks?: TiaFrameworkOptions
  /**
   * Consumers notified about replayed cached outcomes without fabricating
   * Vitest test cases.
   */
  replayAdapters?: TiaReplayAdapter | TiaReplayAdapter[]
  /**
   * Explicit third-party Vitest reporter instances that should receive
   * detached ready/result events for cached tests.
   */
  replayReporters?: TiaReplayReporter | TiaReplayReporter[]
}

export interface NormalizedOptions {
  cacheDir: string
  coverage: false | NormalizedCoverageOptions
  enabled: boolean
  exclude: string[]
  fresh: boolean
  artifactProviders: TiaArtifactProvider[]
  frameworkAdapters: TiaFrameworkEdgeAdapter[]
  frameworkFingerprint: string
  ignoreChanges: string[]
  include: string[]
  log: boolean
  onUnknownChange: 'full' | 'ignore'
  replayAdapters: TiaReplayAdapter[]
  replayReporters: TiaReplayReporter[]
  shardGroup?: string
}

export interface NormalizedCoverageOptions {
  clean: boolean
  cleanOnRerun: boolean
  exclude: string[]
  include: string[] | null
  reportOnFailure: boolean
  reporters: TiaCoverageReporterConfig[]
  reportsDirectory: string
  skipFull: boolean
  thresholds: TiaCoverageThresholds | null
  watermarks: Required<TiaCoverageWatermarks>
}

export type CachedTestState = 'passed' | 'failed' | 'skipped'

export interface CachedTestResult {
  duration?: number
  file: string
  fullName: string
  id: string
  state: CachedTestState
}

export interface Baseline {
  sha: string
  /**
   * Git baselines store the commit plus dirty-file hashes. Filesystem
   * baselines store a full content snapshot when Git or HEAD is unavailable.
   */
  source?: 'filesystem' | 'git'
  /**
   * Dirty-file hashes for Git baselines, or every relevant project-file hash
   * for filesystem baselines.
   */
  workingTree: Record<string, string>
}

/**
 * JavaScript SDK cache graph.
 *
 * This graph stores runner results and Istanbul coverage needed by Vitest,
 * Node, Bun, and Playwright replay. It is not the portable protocol graph and
 * may rebuild safely when its internal schema changes.
 */
export interface TiaRuntimeGraph {
  baseline: Baseline
  collectionCoverage: Record<string, TiaCoverageMap>
  complete: boolean
  coverageComplete: boolean
  edges: Record<string, string[]>
  fingerprint: string
  partition?: TiaRuntimeGraphPartition
  results: Record<string, CachedTestResult>
  schema: number
  testCoverage: Record<string, TiaCoverageMap>
  testEdges: Record<string, TiaTestEdge>
  updatedAt: string
}

export interface TiaRuntimeGraphPartition {
  group?: string
  index: number
  total: number
}

export interface TiaTestEdge {
  file: string
  files: string[]
}

export type RunMode = 'record' | 'replay'

export interface RunPlan {
  affectedTestIds: string[]
  affectedTests: string[]
  changedFiles: string[]
  graph: TiaRuntimeGraph | null
  mode: RunMode
  reason: string
  replayedTests: number
  wholeTestFiles: string[]
}

export interface TiaModuleMeta {
  collectionCoverage: TiaCoverageMap
  collectionFiles: string[]
  /**
   * Concurrent cases share one Istanbul counter map. When true, dependency
   * and coverage precision is deliberately kept at the test-file boundary.
   */
  concurrent: boolean
  files: string[]
}

export interface TiaTestMeta {
  coverage: TiaCoverageMap
  files: string[]
}

export interface TiaTestSelection {
  mode: 'all' | 'tests'
  testIds: string[]
  wholeTestFiles: string[]
}

export interface TiaRuntime {
  active: boolean
  baselineAtStart: Baseline | null
  coverage: TiaCoverageRuntime
  fingerprintAtStart: string
  graphAtStart: TiaRuntimeGraph | null
  graphDigestAtStart: string | null
  ignoredPrefixes: string[]
  instrumenter: Instrumenter | null
  options: NormalizedOptions
  partition: TiaRuntimeGraphPartition | null
  plan: RunPlan | null
  root: string
  structuralFiles: string[]
  writeCacheDir: string
}

export interface TiaCoverageRuntime {
  clean: boolean
  cleanOnRerun: boolean
  enabled: boolean
  exclude: string[]
  include: string[] | null
  reportOnFailure: boolean
  reportsDirectory: string
  reporters: TiaCoverageReporterRuntime[]
  skipFull: boolean
  thresholds: TiaCoverageThresholds | null
  watermarks: Required<TiaCoverageWatermarks>
}

export interface TiaCoverageReporterRuntime {
  name: string
  options: Record<string, unknown>
}

export type TiaCoverageMap = Record<string, FileCoverageData>

export interface CoverageFile
  extends Partial<Omit<FileCoverageData, 'b' | 'f' | 'path' | 's'>> {
  b?: Record<string, number[]>
  f?: Record<string, number>
  path?: string
  s?: Record<string, number>
}

export type CoverageMapLike = Record<string, CoverageFile>
