import type { TiaSuiteDescriptor } from '../../core/protocol.ts'
import type {
  ExternalGraphOptions,
  ExternalPlanFields,
  ExternalRunOptions,
  ExternalSuitesResult,
} from '../../core/external.ts'

export interface K6Suite extends TiaSuiteDescriptor {
  profile: string
}

export interface DiscoverK6Options {
  profiles: string
  project: string
  root: string
}

export type K6GraphOptions = ExternalGraphOptions<K6Suite>

export interface PlanK6Options extends DiscoverK6Options, ExternalPlanFields {
  allowedProfiles?: string[]
}

export interface TiaK6Options extends ExternalRunOptions<PlanK6Options> {
  maxConcurrency?: number
}

export type TiaK6Result = ExternalSuitesResult
