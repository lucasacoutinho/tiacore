// Receipts and snapshots of `tiacore verify`.
import type { TiaImpactGraph, TiaImpactPlan } from './protocol.ts'
import type { TiaReplayRunEvent } from './replay.ts'
import type { TiaRuntimeGraph } from './runtime.ts'

export const TIA_VERIFICATION_RECEIPT_VERSION = 2 as const
export const TIA_VERIFICATION_SNAPSHOT_VERSION = 1 as const

export type TiaVerificationPhase = 'full' | 'selective'

/** What a test-granular runner writes: a runtime graph and its replay plan. */
export interface TiaVerificationSnapshot {
  executedTestIds: string[]
  generatedAt: string
  graph: TiaRuntimeGraph
  /** Absent in every snapshot written before suite-granular runners existed. */
  kind?: 'runtime'
  phase: TiaVerificationPhase
  plan: TiaReplayRunEvent
  runner: string
  schema: typeof TIA_VERIFICATION_SNAPSHOT_VERSION
  success: boolean
}

/**
 * What a suite ran to. `unknown` means the run cannot say: a suite whose
 * failure the runner could not tell from its siblings', or one with no report.
 */
export type TiaSuiteOutcome = 'failed' | 'passed' | 'unknown'

/**
 * What a suite-granular runner (k6, Maestro, Gradle, the Python and Go SDKs)
 * writes: the protocol plan it ran, the suites that ran, how each ended and
 * the impact graph it recorded. A suite plays the part of a test, so
 * `executedTestIds` lists suite ids.
 */
export interface TiaProtocolVerificationSnapshot {
  executedTestIds: string[]
  generatedAt: string
  graph: TiaImpactGraph
  kind: 'protocol'
  phase: TiaVerificationPhase
  plan: TiaImpactPlan
  runner: string
  schema: typeof TIA_VERIFICATION_SNAPSHOT_VERSION
  success: boolean
  /** One entry per executed suite; an executed suite without one is `unknown`. */
  suiteOutcomes: Record<string, TiaSuiteOutcome>
}

export type TiaPhaseSnapshot =
  | TiaProtocolVerificationSnapshot
  | TiaVerificationSnapshot

export type TiaVerificationIssueCode =
  | 'coverage-mismatch'
  | 'dependency-mismatch'
  | 'duplicate-snapshot'
  | 'full-run-failed'
  | 'incomplete-graph'
  | 'missing-full-snapshot'
  | 'missing-selective-snapshot'
  | 'outcome-mismatch'
  | 'selection-miss'
  | 'selective-run-failed'
  | 'snapshot-invalid'

export type TiaCoverageCounterKind = 'branch' | 'function' | 'statement'

export interface TiaCoverageDifference {
  kind: TiaCoverageCounterKind
  sourceFile: string
  testFile: string
}

export interface TiaVerificationIssue {
  code: TiaVerificationIssueCode
  differences?: TiaCoverageDifference[]
  message: string
  runner?: string
}

export interface TiaVerificationRunnerResult {
  issues: TiaVerificationIssue[]
  runner: string
  selection: TiaVerificationSelection | null
  /** `suite` when the selection ids are suite ids; absent for tests. */
  unit?: 'suite'
  verified: boolean
}

export interface TiaVerificationSelection {
  changedFiles: string[]
  executedTestIds: string[]
  expectedTestIds: string[]
  falseNegativeRate: number
  missedTestIds: string[]
  precision: number | null
  unnecessaryTestIds: string[]
}

export interface TiaVerificationAccuracy {
  executedTests: number
  expectedTests: number
  falseNegativeRate: number
  missedTests: number
  precision: number | null
  unnecessaryTests: number
}

export interface TiaVerificationRunnerMetrics {
  executedTests: number
  mode: TiaReplayRunEvent['mode']
  reason: string
  replayedTests: number
  runner: string
}

export interface TiaVerificationPhaseResult {
  duration: number
  metrics: TiaVerificationRunnerMetrics[]
  runners: string[]
  status: number
}

export interface TiaVerificationFallback {
  reason: string
  runner: string
}

export interface TiaVerificationPerformance {
  durationSaved: number
  executionReduction: number | null
  fallbacks: TiaVerificationFallback[]
  fullExecutedTests: number
  selectiveExecutedTests: number
  selectiveReplayedTests: number
  speedup: number | null
}

export interface TiaVerificationReceipt {
  accuracy: TiaVerificationAccuracy
  command: string[]
  completedAt: string
  duration: number
  issues: TiaVerificationIssue[]
  performance: TiaVerificationPerformance
  phases: {
    full: TiaVerificationPhaseResult
    selective: TiaVerificationPhaseResult
  }
  runners: TiaVerificationRunnerResult[]
  schema: typeof TIA_VERIFICATION_RECEIPT_VERSION
  startedAt: string
  success: boolean
  verified: boolean
}

export interface TiaVerificationOptions {
  arguments?: string[]
  artifactsDirectory?: string
  command: string
  cwd?: string
  environment?: NodeJS.ProcessEnv
  keepArtifacts?: boolean
  output?: string
}
