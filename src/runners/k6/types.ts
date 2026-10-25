import type { AdapterExecution } from '../../core/execution.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaImpactPlan,
  TiaInvalidator,
  TiaSuiteDescriptor,
} from '../../core/protocol.ts'

export interface K6Suite extends TiaSuiteDescriptor {
  profile: string
}

export interface DiscoverK6Options {
  profiles: string
  project: string
  root: string
}

export interface K6GraphOptions {
  environmentFingerprint: string
  fingerprint?: string
  invalidators?: TiaInvalidator[]
  knownSources?: string[]
  observations?: TiaDependencyObservation[]
  suites: K6Suite[]
}

export interface PlanK6Options extends DiscoverK6Options {
  allowedProfiles?: string[]
  changes: string[]
  currentEnvironmentFingerprint: string
  currentFingerprint?: string
  forceFull?: boolean
  graph: TiaImpactGraph | null
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

export interface TiaK6Options extends Omit<PlanK6Options, 'graph'> {
  command?: string
  commandArguments?: string[]
  environment?: NodeJS.ProcessEnv
  graph?: TiaImpactGraph | null
  graphPath?: string
  maxConcurrency?: number
}

export interface TiaK6Result {
  executions: AdapterExecution[]
  plan: TiaImpactPlan
  status: number
  success: boolean
}
