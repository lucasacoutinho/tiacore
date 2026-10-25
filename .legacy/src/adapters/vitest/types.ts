import type { Instrumenter } from 'istanbul-lib-instrument'

import type {
  EngineOptions,
  Baseline,
  RunPlan,
  TiaRuntimeGraph,
  TiaRuntimeGraphPartition,
} from '../../engine/types.js'
import type { TiaReplayReporter } from '../../engine/replay/types.js'
import type { CoverageTemplates } from '../../integrations/coverage/templates.js'
import type {
  NormalizedCoverageOptions,
  TiaCoverageCounterMap,
  TiaCoverageRuntime,
} from '../../integrations/coverage/types.js'
import type { TiaFrameworkEdgeAdapter } from '../../integrations/edges/types.js'

export interface NormalizedOptions extends EngineOptions {
  coverage: false | NormalizedCoverageOptions
  enabled: boolean
  frameworkAdapters: TiaFrameworkEdgeAdapter[]
  replayReporters: TiaReplayReporter[]
  shardGroup?: string
}

export interface TiaModuleMeta {
  collectionCoverage: TiaCoverageCounterMap
  collectionFiles: string[]
  concurrent: boolean
  files: string[]
}

export interface TiaTestMeta {
  coverage: TiaCoverageCounterMap
  files: string[]
}

export interface TiaTestSelection {
  mode: 'all' | 'tests'
  testIds: string[]
  wholeTestFiles: string[]
}

export interface TiaRuntime {
  active: boolean
  baselineAtStart: Baseline | null
  coverage: TiaCoverageRuntime
  coverageTemplates: CoverageTemplates
  fingerprintAtStart: string
  graphAtStart: TiaRuntimeGraph | null
  graphDigestAtStart: string | null
  ignoredPrefixes: string[]
  instrumenter: Instrumenter | null
  options: NormalizedOptions
  partition: TiaRuntimeGraphPartition | null
  plan: RunPlan | null
  root: string
  structuralFiles: string[]
  writeCacheDir: string
}
