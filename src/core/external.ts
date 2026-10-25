import type { AdapterExecution } from './execution.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaImpactPlan,
  TiaInvalidator,
} from './protocol.ts'

// The public option and result shapes the Gradle, k6 and Maestro adapters
// share; each adapter's own types extend these.

/** The planner inputs every external adapter takes. */
export interface ExternalPlanFields {
  changes: string[]
  currentEnvironmentFingerprint: string
  currentFingerprint?: string
  forceFull?: boolean
  graph: TiaImpactGraph | null
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

/** The graph inputs k6 and Maestro take; only the suite type differs. */
export interface ExternalGraphOptions<Suite> {
  environmentFingerprint: string
  fingerprint?: string
  invalidators?: TiaInvalidator[]
  knownSources?: string[]
  observations?: TiaDependencyObservation[]
  suites: Suite[]
}

/**
 * What a runner adds to its plan options: the command to run and a graph that
 * may be given, or else read from `graphPath`.
 */
export type ExternalRunOptions<Plan extends ExternalPlanFields> = Omit<
  Plan,
  'graph'
> & {
  command?: string
  commandArguments?: string[]
  environment?: NodeJS.ProcessEnv
  graph?: TiaImpactGraph | null
  graphPath?: string
}

/** What a runner of external suites returns. */
export interface ExternalSuitesResult {
  executions: AdapterExecution[]
  plan: TiaImpactPlan
  status: number
  success: boolean
}
