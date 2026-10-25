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
  source?: 'filesystem' | 'git'
  workingTree: Record<string, string>
}

export type RunMode = 'record' | 'replay'

export interface RunPlanBaseline {
  artifactId?: Array<number | string> | number | string
  origin: 'artifact' | 'local' | 'none'
  provider?: string
  reason: string
  sha: string | null
  source: Baseline['source'] | null
}

export interface RunPlanRunDecision {
  reasons: string[]
  target: 'run'
}

export interface RunPlanTestCaseDecision {
  file: string
  id: string
  reasons: string[]
  target: 'test-case'
}

export interface RunPlanTestFileDecision {
  file: string
  reasons: string[]
  target: 'test-file'
}

export type RunPlanDecision =
  | RunPlanRunDecision
  | RunPlanTestCaseDecision
  | RunPlanTestFileDecision
