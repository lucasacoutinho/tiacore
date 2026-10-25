import type { TiaObservation } from '../../engine/run.js'

export const PLAYWRIGHT_DEPENDENCIES_ATTACHMENT = 'tiacore.dependencies.json'
export const PLAYWRIGHT_SESSION_ENV = 'TIA_PLAYWRIGHT_SESSION'
export const PLAYWRIGHT_ROOT_ENV = 'TIA_PLAYWRIGHT_ROOT'

export interface PlaywrightObservation extends TiaObservation {
  dependenciesComplete: boolean
}

export interface PlaywrightRunReport {
  configuredTestIds: string[]
  observations: PlaywrightObservation[]
  status: 'failed' | 'interrupted' | 'passed' | 'timedout'
}
