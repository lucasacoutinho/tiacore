import type {
  TiaImpactPlan,
  TiaInvalidator,
  TiaSuiteDescriptor,
} from '../../core/protocol.ts'
import type {
  ExternalPlanFields,
  ExternalRunOptions,
} from '../../core/external.ts'

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

export interface PlanGradleOptions
  extends DiscoverGradleOptions, ExternalPlanFields {}

export interface TiaGradleOptions extends ExternalRunOptions<PlanGradleOptions> {
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
