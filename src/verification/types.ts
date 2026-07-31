import type { TiaReplayRunEvent } from '../engine/replay/types.js'
import type { TiaRuntimeGraph } from '../engine/types.js'

export const TIA_VERIFICATION_RECEIPT_VERSION = 2 as const
export const TIA_VERIFICATION_SNAPSHOT_VERSION = 1 as const

export type TiaVerificationPhase = 'full' | 'selective'

export interface TiaVerificationSnapshot {
  executedTestIds: string[]
  generatedAt: string
  graph: TiaRuntimeGraph
  phase: TiaVerificationPhase
  plan: TiaReplayRunEvent
  runner: string
  schema: typeof TIA_VERIFICATION_SNAPSHOT_VERSION
  success: boolean
}

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

export interface TiaVerificationIssue {
  code: TiaVerificationIssueCode
  message: string
  runner?: string
}

export interface TiaVerificationRunnerResult {
  issues: TiaVerificationIssue[]
  runner: string
  selection: TiaVerificationSelection | null
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
