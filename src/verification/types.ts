import type { TiaReplayRunEvent } from '../engine/replay/types.js'
import type { TiaRuntimeGraph } from '../engine/types.js'

export type TiaVerificationPhase = 'full' | 'selective'

export interface TiaVerificationSnapshot {
  executedTestIds: string[]
  generatedAt: string
  graph: TiaRuntimeGraph
  phase: TiaVerificationPhase
  plan: TiaReplayRunEvent
  runner: string
  schema: 1
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
  verified: boolean
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
  schema: 1
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
