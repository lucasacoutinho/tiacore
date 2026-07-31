import type {
  TiaCoreOptions,
  TiaObservation,
} from './run.js'
import type { RunPlan } from './types.js'

export interface TiaRunnerOptions
  extends Omit<TiaCoreOptions, 'files' | 'runner'> {
  /**
   * Maximum test files observed at once. Cases within one file remain
   * sequential to preserve the runner's file-local isolation assumptions.
   *
   * @default min(4, available CPU parallelism)
   */
  concurrency?: number
  files?: string[]
}

export interface TiaRunnerResult {
  executedTests: TiaObservation[]
  graphSaved: boolean
  plan: RunPlan
  replayedTests: number
  success: boolean
}

export interface TiaRunner {
  run(): Promise<TiaRunnerResult>
}
