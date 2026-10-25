// Events a replay adapter receives when cached results stand in for skipped tests.
import type {
  CachedTestResult,
  RunPlanBaseline,
  RunPlanDecision,
  RunMode,
} from './runtime.ts'

export interface TiaReplayRunEvent {
  affectedTestIds: string[]
  affectedTests: string[]
  baseline: RunPlanBaseline
  changedFiles: string[]
  decisions: RunPlanDecision[]
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
