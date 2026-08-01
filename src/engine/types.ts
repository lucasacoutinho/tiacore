import type {
  TiaArtifactProvider,
  TiaArtifactTrustPolicy,
} from './artifacts/types.js'
import type { TiaReplayAdapter } from './replay/types.js'
import type { TiaCoverageMap } from '../integrations/coverage/types.js'
import type {
  Baseline,
  CachedTestResult,
  RunPlanBaseline,
  RunPlanDecision,
  RunMode,
} from './contracts.js'

export type {
  Baseline,
  CachedTestResult,
  CachedTestState,
  RunMode,
  RunPlanBaseline,
  RunPlanDecision,
  RunPlanRunDecision,
  RunPlanTestCaseDecision,
  RunPlanTestFileDecision,
} from './contracts.js'

export interface TiaRuntimeGraph {
  baseline: Baseline
  collectionCoverage: Record<string, TiaCoverageMap>
  complete: boolean
  coverageComplete: boolean
  edges: Record<string, string[]>
  fingerprint: string
  partition?: TiaRuntimeGraphPartition
  results: Record<string, CachedTestResult>
  schema: number
  testCoverage: Record<string, TiaCoverageMap>
  testEdges: Record<string, TiaTestEdge>
  updatedAt: string
}

export interface TiaRuntimeGraphPartition {
  group?: string
  index: number
  total: number
}

export interface TiaTestEdge {
  file: string
  files: string[]
}

export interface RunPlan {
  affectedTestIds: string[]
  affectedTests: string[]
  baseline: RunPlanBaseline
  changedFiles: string[]
  decisions: RunPlanDecision[]
  graph: TiaRuntimeGraph | null
  mode: RunMode
  reason: string
  replayedTests: number
  wholeTestFiles: string[]
}

export interface RuntimePlanOptions {
  fresh: boolean
  ignoreChanges: string[]
  onUnknownChange: 'full' | 'ignore'
}

export interface FingerprintOptions extends RuntimePlanOptions {
  exclude: string[]
  frameworkFingerprint: string
  include: string[]
}

export interface EngineOptions extends FingerprintOptions {
  artifactProviders: TiaArtifactProvider[]
  artifactTrust: TiaArtifactTrustPolicy
  cacheDir: string
  log: boolean
  replayAdapters: TiaReplayAdapter[]
}
