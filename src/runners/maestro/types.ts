import type { AdapterExecution } from '../../core/execution.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaImpactPlan,
  TiaInvalidator,
  TiaSuiteDescriptor,
} from '../../core/protocol.ts'

export interface MaestroSuite extends TiaSuiteDescriptor {
  appId?: string
  name: string
}

export interface DiscoverMaestroOptions {
  excludeTags?: string[]
  flows: string
  includeTags?: string[]
  project: string
  root: string
}

export interface MaestroGraphOptions {
  environmentFingerprint: string
  fingerprint?: string
  invalidators?: TiaInvalidator[]
  knownSources?: string[]
  observations?: TiaDependencyObservation[]
  suites: MaestroSuite[]
}

export interface PlanMaestroOptions extends DiscoverMaestroOptions {
  changes: string[]
  currentEnvironmentFingerprint: string
  currentFingerprint?: string
  forceFull?: boolean
  graph: TiaImpactGraph | null
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

export interface TiaMaestroOptions extends Omit<PlanMaestroOptions, 'graph'> {
  command?: string
  commandArguments?: string[]
  environment?: NodeJS.ProcessEnv
  graph?: TiaImpactGraph | null
  graphPath?: string
  maxConcurrency?: number
}

export interface TiaMaestroResult {
  executions: AdapterExecution[]
  plan: TiaImpactPlan
  status: number
  success: boolean
}
