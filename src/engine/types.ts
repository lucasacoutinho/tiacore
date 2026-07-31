import type { TiaArtifactProvider } from './artifacts/types.js'
import type { TiaReplayAdapter } from './replay/types.js'
import type { TiaCoverageMap } from '../integrations/coverage/types.js'

export type CachedTestState = 'passed' | 'failed' | 'skipped'

export interface CachedTestResult {
  duration?: number
  file: string
  fullName: string
  id: string
  state: CachedTestState
}

export interface Baseline {
  sha: string
  source?: 'filesystem' | 'git'
  workingTree: Record<string, string>
}

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

export type RunMode = 'record' | 'replay'

export interface RunPlanBaseline {
  artifactId?: Array<number | string> | number | string
  origin: 'artifact' | 'local' | 'none'
  provider?: string
  reason: string
  sha: string | null
  source: Baseline['source'] | null
}

export interface RunPlanRunDecision {
  reasons: string[]
  target: 'run'
}

export interface RunPlanTestCaseDecision {
  file: string
  id: string
  reasons: string[]
  target: 'test-case'
}

export interface RunPlanTestFileDecision {
  file: string
  reasons: string[]
  target: 'test-file'
}

export type RunPlanDecision =
  | RunPlanRunDecision
  | RunPlanTestCaseDecision
  | RunPlanTestFileDecision

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
  cacheDir: string
  log: boolean
  replayAdapters: TiaReplayAdapter[]
}
