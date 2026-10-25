import type { TiaFrameworkOptions } from '../../engine/edges/types.ts'
import type { RunPlan } from '../../core/runtime.ts'

export interface TiaPlaywrightOptions {
  cacheDir?: string
  config?: string
  cwd?: string
  evidenceDirectory?: string
  evidenceHeader?: string
  fresh?: boolean
  frameworks?: TiaFrameworkOptions
  ignoreChanges?: string[]
  log?: boolean
  name?: string
  onUnknownChange?: 'full' | 'ignore'
  root?: string
}

export interface TiaPlaywrightResult {
  /**
   * Why this run did not behave as the plan said, or why the graph was not
   * updated: a path filter that was too long to pass on, a spec without
   * dependency evidence, an incomplete Playwright report. Empty when nothing
   * went wrong.
   */
  notes: string[]
  plan: RunPlan
  status: number
  success: boolean
}
