// Runtime graph of the runner adapters (Vitest, Node, Bun, Playwright and the
// generic adapter). src/wire/runtime-graph.ts validates stored graphs against it.
import type { FileCoverageData } from 'istanbul-lib-coverage'

/** Bumped from 4 in 2.0: hook-marker attribution and code-unit ordering. */
export const GRAPH_SCHEMA_VERSION = 5

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

/** Static maps and zeroed counters of one instrumented file. */
export type TiaCoverageTemplate = Omit<FileCoverageData, 'path'>

/**
 * Counters one test or collection window advanced in one file. Only nonzero
 * statement and function counters appear; a branch appears with all of its
 * paths when any path advanced. `map` names the file's entry in the graph's
 * `coverageMaps` table.
 */
export interface TiaCoverageHits {
  b: Record<string, number[]>
  f: Record<string, number>
  map: string
  s: Record<string, number>
}

/** Project-relative file paths mapped to the counters they advanced. */
export type TiaCoverageRecord = Record<string, TiaCoverageHits>

export interface TiaRuntimeGraphPartition {
  group?: string
  index: number
  total: number
}

export interface TiaTestEdge {
  file: string
  files: string[]
}

export interface TiaRuntimeGraph {
  baseline: Baseline
  collectionCoverage: Record<string, TiaCoverageRecord>
  complete: boolean
  coverageComplete: boolean
  /** Static Istanbul maps keyed by the digest that coverage records name. */
  coverageMaps: Record<string, TiaCoverageTemplate>
  edges: Record<string, string[]>
  fingerprint: string
  partition?: TiaRuntimeGraphPartition
  results: Record<string, CachedTestResult>
  schema: number
  testCoverage: Record<string, TiaCoverageRecord>
  testEdges: Record<string, TiaTestEdge>
  updatedAt: string
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
