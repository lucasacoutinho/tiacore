// Wire types of protocol v1 (spec/protocol-v1.md). src/wire/protocol.ts decodes into them.

export const TIA_PROTOCOL_VERSION = 1 as const

export type TiaProtocolVersion = typeof TIA_PROTOCOL_VERSION

export type TiaEdgeKind =
  | 'capability'
  | 'configuration'
  | 'conservative'
  | 'database'
  | 'executed'
  | 'fixture'
  | 'import'
  | 'lazy'
  | 'route'
  | 'view'

export type TiaEdgeConfidence =
  | 'conservative'
  | 'exact'
  | 'inferred'
  | 'observed'

export interface TiaSuiteDescriptor {
  adapter: string
  dependsOn?: string[]
  file: string
  id: string
  project: string
  resourceLocks?: string[]
  tags?: string[]
}

export interface TiaDependencyObservation {
  confidence: TiaEdgeConfidence
  kind: TiaEdgeKind
  source: string
  suiteId: string
}

export interface TiaInvalidator {
  pattern: string
  reason: string
}

/**
 * Runner-neutral graph exchanged between adapters and the planner.
 *
 * Volatile run metadata belongs in TiaArtifactEnvelope rather than this
 * deterministic graph.
 */
export interface TiaImpactGraph {
  complete: boolean
  environmentFingerprint: string
  fingerprint: string
  invalidators?: TiaInvalidator[]
  knownSources?: string[]
  observations: TiaDependencyObservation[]
  protocolVersion: TiaProtocolVersion
  suites: TiaSuiteDescriptor[]
}

export interface TiaChangeSet {
  files: string[]
  provider?: string
}

export interface TiaExecutionPolicy {
  allowedSuites?: string[]
  expectedEnvironmentFingerprint?: string
  expectedFingerprint?: string
  forceFull?: boolean
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

export type TiaImpactPlanMode = 'full' | 'selective' | 'skip'

export interface TiaImpactPlan {
  cached: string[]
  changedFiles: string[]
  mode: TiaImpactPlanMode
  protocolVersion: TiaProtocolVersion
  reason: string
  reasons: Record<string, string[]>
  resourceLocks: string[]
  selected: string[]
}

export interface TiaArtifactEnvelope {
  adapter: string
  artifactId: string
  graph: TiaImpactGraph
  partition?: {
    group?: string
    index: number
    total: number
  }
  runId: string
}

export interface TiaImpactPlanInput {
  catalog: TiaSuiteDescriptor[]
  changes: TiaChangeSet
  currentEnvironmentFingerprint: string
  currentFingerprint: string
  graph: TiaImpactGraph | null
  policy?: TiaExecutionPolicy
}

export const TIA_PROTOCOL_LIMITS = Object.freeze({
  invalidators: 10_000,
  knownSources: 1_000_000,
  observations: 1_000_000,
  pathLength: 4_096,
  relationsPerSuite: 100_000,
  stringLength: 8_192,
  suites: 100_000,
})
