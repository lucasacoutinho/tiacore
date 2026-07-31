import type {
  TiaArtifactSource,
  TiaArtifactTrustPolicy,
} from '../engine/artifacts/types.js'
import type { TiaReplayAdapter } from '../engine/replay/types.js'
import type { TiaObservation } from '../engine/run.js'
import type { RunPlan, TiaRuntimeGraph } from '../engine/types.js'

export const TIA_TYPESCRIPT_ADAPTER_VERSION = 1 as const

export type TiaTypescriptAdapterFeature =
  | 'cached-outcomes'
  | 'parallelism'
  | 'subprocess-observation'
  | 'worktrees'

export interface TiaAdapterDefinition<Metadata = unknown> {
  apiVersion: typeof TIA_TYPESCRIPT_ADAPTER_VERSION
  discover(
    context: TiaAdapterDiscoveryContext,
  ): Promise<TiaAdapterCatalog<Metadata>> | TiaAdapterCatalog<Metadata>
  execute(
    context: TiaAdapterExecutionContext<Metadata>,
  ): Promise<TiaAdapterExecution> | TiaAdapterExecution
  features?: TiaTypescriptAdapterFeature[]
  name: string
  version: string
}

export interface TiaAdapterDiscoveryContext {
  root: string
}

export interface TiaAdapterCatalog<Metadata = unknown> {
  files?: string[]
  fingerprint?: string
  tests: Array<TiaAdapterTest<Metadata>>
}

export interface TiaAdapterTest<Metadata = unknown> {
  data?: Metadata
  file: string
  fullName: string
  id: string
}

export interface TiaAdapterSelectedTest<
  Metadata = unknown,
> extends TiaAdapterTest<Metadata> {
  source: 'baseline' | 'catalog'
}

export interface TiaAdapterExecutionContext<Metadata = unknown> {
  plan: RunPlan
  root: string
  tests: Array<TiaAdapterSelectedTest<Metadata>>
  wholeTestFiles: string[]
}

export interface TiaAdapterExecution {
  complete: boolean
  fullyExecutedFiles?: string[]
  observations: TiaObservation[]
}

export interface TiaAdapterOptions {
  artifacts?: TiaArtifactSource | TiaArtifactSource[]
  artifactTrust?: TiaArtifactTrustPolicy
  cacheDir?: string
  exclude?: string[]
  fresh?: boolean
  ignoreChanges?: string[]
  include?: string[]
  log?: boolean
  onUnknownChange?: 'full' | 'ignore'
  replayAdapters?: TiaReplayAdapter | TiaReplayAdapter[]
  root?: string
}

export interface TiaAdapterResult {
  complete: boolean
  executedTests: TiaObservation[]
  graph: TiaRuntimeGraph | null
  graphSaved: boolean
  plan: RunPlan
  replayedTests: number
  selectedTests: number
  success: boolean
}
