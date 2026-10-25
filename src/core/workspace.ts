/** Anything with a `run()` method: TiaK6Runner, TiaCore-based runners, ... */
export interface TiaWorkspaceLaneRunner {
  run(): Promise<unknown>
}

export interface TiaWorkspaceLane {
  arguments?: string[]
  command?: string
  cwd?: string
  dependsOn?: string[]
  environment?: Record<string, string | undefined>
  id: string
  resourceLocks?: string[]
  runner?: TiaWorkspaceLaneRunner
}

export interface TiaWorkspaceOptions {
  concurrency?: number
  failFast?: boolean
  lanes: TiaWorkspaceLane[]
  root?: string
}

export type TiaWorkspaceLaneStatus = 'blocked' | 'failed' | 'passed'

export interface TiaWorkspaceLaneResult {
  duration: number
  error?: string
  id: string
  result?: unknown
  status: TiaWorkspaceLaneStatus
}

export interface TiaWorkspaceResult {
  lanes: TiaWorkspaceLaneResult[]
  success: boolean
}
