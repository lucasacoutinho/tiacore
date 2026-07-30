import { normalizeProtocolPath } from './paths.js'
import {
  TIA_PROTOCOL_VERSION,
  type TiaDependencyObservation,
  type TiaImpactGraph,
  type TiaSuiteDescriptor,
} from './types.js'

const EDGE_KINDS = new Set([
  'capability',
  'configuration',
  'conservative',
  'database',
  'executed',
  'fixture',
  'import',
  'lazy',
  'route',
  'view',
])
const EDGE_CONFIDENCES = new Set([
  'conservative',
  'exact',
  'inferred',
  'observed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isSuite(value: unknown): value is TiaSuiteDescriptor {
  if (!isRecord(value)) return false
  return (
    typeof value.adapter === 'string' &&
    typeof value.file === 'string' &&
    typeof value.id === 'string' &&
    typeof value.project === 'string' &&
    (value.dependsOn === undefined || isStringArray(value.dependsOn)) &&
    (value.resourceLocks === undefined || isStringArray(value.resourceLocks)) &&
    (value.tags === undefined || isStringArray(value.tags))
  )
}

function isObservation(value: unknown): value is TiaDependencyObservation {
  if (!isRecord(value)) return false
  return (
    typeof value.source === 'string' &&
    typeof value.suiteId === 'string' &&
    typeof value.kind === 'string' &&
    EDGE_KINDS.has(value.kind) &&
    typeof value.confidence === 'string' &&
    EDGE_CONFIDENCES.has(value.confidence)
  )
}

export function parseImpactGraph(value: unknown): TiaImpactGraph {
  if (!isRecord(value)) {
    throw new Error('TIA impact graph must be an object')
  }
  if (value.protocolVersion !== TIA_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported TIA protocol version: ${String(value.protocolVersion)}`,
    )
  }
  if (
    typeof value.complete !== 'boolean' ||
    typeof value.environmentFingerprint !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    !Array.isArray(value.suites) ||
    !value.suites.every(isSuite) ||
    !Array.isArray(value.observations) ||
    !value.observations.every(isObservation)
  ) {
    throw new Error('TIA impact graph has an invalid shape')
  }
  if (
    value.knownSources !== undefined &&
    !isStringArray(value.knownSources)
  ) {
    throw new Error('TIA impact graph knownSources must be strings')
  }
  if (
    value.invalidators !== undefined &&
    (
      !Array.isArray(value.invalidators) ||
      !value.invalidators.every(
        (invalidator) =>
          isRecord(invalidator) &&
          typeof invalidator.pattern === 'string' &&
          typeof invalidator.reason === 'string',
      )
    )
  ) {
    throw new Error('TIA impact graph invalidators have an invalid shape')
  }

  const graph = value as unknown as TiaImpactGraph
  const suites = new Map<string, TiaSuiteDescriptor>()
  for (const suite of graph.suites) {
    if (suite.id.trim() === '' || suites.has(suite.id)) {
      throw new Error(`TIA impact graph has a duplicate or empty suite id: ${suite.id}`)
    }
    normalizeProtocolPath(suite.file)
    suites.set(suite.id, suite)
  }
  for (const suite of graph.suites) {
    for (const dependency of suite.dependsOn ?? []) {
      if (!suites.has(dependency)) {
        throw new Error(`TIA suite ${suite.id} depends on unknown suite ${dependency}`)
      }
    }
  }
  for (const observation of graph.observations) {
    if (!suites.has(observation.suiteId)) {
      throw new Error(
        `TIA observation references unknown suite ${observation.suiteId}`,
      )
    }
    normalizeProtocolPath(observation.source)
  }
  for (const source of graph.knownSources ?? []) {
    normalizeProtocolPath(source)
  }
  return structuredClone(graph)
}
