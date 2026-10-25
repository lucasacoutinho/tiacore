import type { TiaSuiteDescriptor } from '../../core/protocol.ts'
import type {
  ExternalGraphOptions,
  ExternalPlanFields,
  ExternalRunOptions,
  ExternalSuitesResult,
} from '../../core/external.ts'

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

export type MaestroGraphOptions = ExternalGraphOptions<MaestroSuite>

export interface PlanMaestroOptions
  extends DiscoverMaestroOptions, ExternalPlanFields {}

export interface TiaMaestroOptions extends ExternalRunOptions<PlanMaestroOptions> {
  maxConcurrency?: number
}

export type TiaMaestroResult = ExternalSuitesResult
