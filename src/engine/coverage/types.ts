import type { FileCoverageData } from 'istanbul-lib-coverage'

export type TiaCoverageReporter =
  | 'clover'
  | 'cobertura'
  | 'html'
  | 'html-spa'
  | 'json'
  | 'json-summary'
  | 'lcov'
  | 'lcovonly'
  | 'text'
  | 'text-lcov'
  | 'text-summary'
  | (string & {})

export type TiaCoverageReporterConfig =
  | TiaCoverageReporter
  | [TiaCoverageReporter, Record<string, unknown>?]

export interface TiaCoverageThresholdValues {
  100?: boolean
  branches?: number
  functions?: number
  lines?: number
  statements?: number
}

export interface TiaCoverageThresholds extends TiaCoverageThresholdValues {
  autoUpdate?: boolean | ((newThreshold: number) => number)
  perFile?: boolean
  [key: string]:
    | boolean
    | number
    | ((newThreshold: number) => number)
    | TiaCoverageThresholdValues
    | undefined
}

export interface TiaCoverageWatermarks {
  branches?: [number, number]
  functions?: [number, number]
  lines?: [number, number]
  statements?: [number, number]
}

export interface TiaCoverageOptions {
  include?: string[]
  exclude?: string[]
  clean?: boolean
  cleanOnRerun?: boolean
  reportsDirectory?: string
  reporters?: TiaCoverageReporterConfig[]
  reportOnFailure?: boolean
  skipFull?: boolean
  thresholds?: TiaCoverageThresholds
  watermarks?: TiaCoverageWatermarks
}

export interface NormalizedCoverageOptions {
  clean: boolean
  cleanOnRerun: boolean
  exclude: string[]
  include: string[] | null
  reportOnFailure: boolean
  reporters: TiaCoverageReporterConfig[]
  reportsDirectory: string
  skipFull: boolean
  thresholds: TiaCoverageThresholds | null
  watermarks: Required<TiaCoverageWatermarks>
}

export interface TiaCoverageRuntime {
  clean: boolean
  cleanOnRerun: boolean
  enabled: boolean
  exclude: string[]
  include: string[] | null
  reportOnFailure: boolean
  reportsDirectory: string
  reporters: TiaCoverageReporterRuntime[]
  skipFull: boolean
  thresholds: TiaCoverageThresholds | null
  watermarks: Required<TiaCoverageWatermarks>
}

export interface TiaCoverageReporterRuntime {
  name: string
  options: Record<string, unknown>
}

export type TiaCoverageMap = Record<string, FileCoverageData>

/** Counters a window advanced in one file; the probe produces them. */
export type { ProbeCounterMap as TiaCoverageCounterMap } from '../../probe/types.ts'
export type { ProbeCounters as TiaCoverageCounters } from '../../probe/types.ts'
export type {
  TiaCoverageHits,
  TiaCoverageRecord,
  TiaCoverageTemplate,
} from '../../core/runtime.ts'
