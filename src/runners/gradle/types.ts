import type {
  TiaImpactGraph,
  TiaImpactPlan,
  TiaInvalidator,
  TiaSuiteDescriptor,
} from '../../core/protocol.ts'

export interface GradleSuite extends TiaSuiteDescriptor {
  className: string
}

export interface DiscoverGradleOptions {
  project: string
  root: string
  sources?: string[]
  tests?: string[]
}

export interface GradleGraphOptions {
  environmentFingerprint: string
  fingerprint?: string
  invalidators?: TiaInvalidator[]
  sources?: string[]
  suites: GradleSuite[]
}

export interface JUnitCase {
  className: string
  durationSeconds?: number
  name: string
  status: 'failed' | 'passed' | 'skipped'
}

export interface PlanGradleOptions extends DiscoverGradleOptions {
  changes: string[]
  currentEnvironmentFingerprint: string
  currentFingerprint?: string
  forceFull?: boolean
  graph: TiaImpactGraph | null
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

export interface TiaGradleOptions extends Omit<PlanGradleOptions, 'graph'> {
  command?: string
  commandArguments?: string[]
  environment?: NodeJS.ProcessEnv
  graph?: TiaImpactGraph | null
  graphPath?: string
  reports?: string[]
  requireReports?: boolean
  task?: string
}

export interface TiaGradleResult {
  cases: JUnitCase[]
  plan: TiaImpactPlan
  status: number
  success: boolean
}
