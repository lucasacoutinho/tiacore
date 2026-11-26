// A fast acceptance path for protocol v1 impact graphs. The ImpactGraph Schema
// (src/wire/protocol.ts) stays the definition: this guard accepts a value only
// when the Schema would accept it, and returns what the Schema decodes it to
// (canonical paths, no unknown keys). Anything it does not accept falls back to
// the Schema, which accepts it or explains why not, so error messages are the
// Schema's. test/wire/impact-graph-guard.test.ts holds the two together.
//
// Plain loops over the decoded shape: a 25,000-suite graph decodes several
// times faster than through the Schema's generic interpreter.

import { invalidatorKey, observationKey } from '../core/canonical.ts'
import { normalizePath } from '../core/path.ts'
import {
  TIA_PROTOCOL_LIMITS as LIMITS,
  TIA_PROTOCOL_VERSION,
  type TiaDependencyObservation,
  type TiaImpactGraph,
  type TiaInvalidator,
  type TiaSuiteDescriptor,
} from '../core/protocol.ts'
import { isRecord } from '../core/record.ts'
import { suiteCycle } from './suite-cycle.ts'

const EDGE_KINDS: ReadonlySet<unknown> = new Set([
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

const EDGE_CONFIDENCES: ReadonlySet<unknown> = new Set([
  'conservative',
  'exact',
  'inferred',
  'observed',
])

const GRAPH_KEYS: ReadonlySet<string> = new Set([
  'complete',
  'environmentFingerprint',
  'fingerprint',
  'invalidators',
  'knownSources',
  'observations',
  'protocolVersion',
  'suites',
])
const SUITE_KEYS: ReadonlySet<string> = new Set([
  'adapter',
  'dependsOn',
  'file',
  'id',
  'project',
  'resourceLocks',
  'tags',
])
const OBSERVATION_KEYS: ReadonlySet<string> = new Set([
  'confidence',
  'kind',
  'source',
  'suiteId',
])
const INVALIDATOR_KEYS: ReadonlySet<string> = new Set(['pattern', 'reason'])

/** Rejected: the Schema decides what is wrong. One instance, thrown often. */
class Reject extends Error {}
const reject = new Reject('rejected by the impact graph guard')

function onlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key in value) {
    if (!allowed.has(key)) throw reject
  }
}

function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > LIMITS.stringLength ||
    value.trim() === ''
  ) {
    throw reject
  }
  return value
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length > LIMITS.stringLength) {
    throw reject
  }
  return value
}

function projectPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > LIMITS.pathLength) {
    throw reject
  }
  const result = normalizePath(value)
  if (result._tag !== 'Accepted') throw reject
  return result.path
}

function array(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw reject
  return value
}

/** A present optional key must hold a value; the Schema rejects `undefined`. */
function optional<T>(
  record: Record<string, unknown>,
  key: string,
  decode: (value: unknown) => T,
): T | undefined {
  if (!(key in record)) return undefined
  return decode(record[key])
}

function distinct(values: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw reject
    seen.add(value)
  }
  return values as string[]
}

function distinctTexts(value: unknown): string[] {
  return distinct(array(value, LIMITS.relationsPerSuite).map(text))
}

function suite(value: unknown): TiaSuiteDescriptor {
  if (!isRecord(value)) throw reject
  onlyKeys(value, SUITE_KEYS)
  const dependsOn = optional(value, 'dependsOn', distinctTexts)
  const resourceLocks = optional(value, 'resourceLocks', distinctTexts)
  const tags = optional(value, 'tags', distinctTexts)
  return {
    adapter: text(value['adapter']),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    file: projectPath(value['file']),
    id: text(value['id']),
    project: text(value['project']),
    ...(resourceLocks === undefined ? {} : { resourceLocks }),
    ...(tags === undefined ? {} : { tags }),
  }
}

function observation(value: unknown): TiaDependencyObservation {
  if (!isRecord(value)) throw reject
  onlyKeys(value, OBSERVATION_KEYS)
  const { confidence, kind } = value
  if (!EDGE_CONFIDENCES.has(confidence) || !EDGE_KINDS.has(kind)) throw reject
  return {
    confidence: confidence as TiaDependencyObservation['confidence'],
    kind: kind as TiaDependencyObservation['kind'],
    source: projectPath(value['source']),
    suiteId: text(value['suiteId']),
  }
}

function invalidator(value: unknown): TiaInvalidator {
  if (!isRecord(value)) throw reject
  onlyKeys(value, INVALIDATOR_KEYS)
  return { pattern: text(value['pattern']), reason: text(value['reason']) }
}

function distinctBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  for (const value of values) {
    const valueKey = key(value)
    if (seen.has(valueKey)) throw reject
    seen.add(valueKey)
  }
  return values
}

// Paths reject NUL and the edge fields are literals, so the Schema's joined
// observation keys can collide only within the same suite, even if its id
// contains NUL. Keep small groups as direct comparisons and bound large ones.
function distinctObservations(
  values: TiaDependencyObservation[],
): TiaDependencyObservation[] {
  const bySuite = new Map<string, TiaDependencyObservation[] | Set<string>>()
  for (const value of values) {
    const previous = bySuite.get(value.suiteId)
    if (previous === undefined) {
      bySuite.set(value.suiteId, [value])
      continue
    }
    if (previous instanceof Set) {
      const key = observationKey(value)
      if (previous.has(key)) throw reject
      previous.add(key)
      continue
    }
    for (const item of previous) {
      if (
        item.source === value.source &&
        item.kind === value.kind &&
        item.confidence === value.confidence
      )
        throw reject
    }
    if (previous.length < 4) {
      previous.push(value)
    } else {
      const keys = new Set(previous.map(observationKey))
      keys.add(observationKey(value))
      bySuite.set(value.suiteId, keys)
    }
  }
  return values
}

/** The ImpactGraph Schema's cross-record rules. */
function checkReferences(graph: TiaImpactGraph): void {
  const suites = new Map<string, TiaSuiteDescriptor>()
  let hasDependencies = false
  for (const item of graph.suites) {
    if (suites.has(item.id)) throw reject
    suites.set(item.id, item)
    if (item.dependsOn !== undefined && item.dependsOn.length > 0)
      hasDependencies = true
  }
  if (hasDependencies) {
    for (const item of graph.suites) {
      for (const dependency of item.dependsOn ?? []) {
        if (!suites.has(dependency)) throw reject
      }
    }
    if (suiteCycle(suites) !== undefined) throw reject
  }
  for (const item of graph.observations) {
    if (!suites.has(item.suiteId)) throw reject
  }
}

/** What the Schema decodes `value` to, or null for the Schema to decide. */
export function acceptImpactGraph(value: unknown): TiaImpactGraph | null {
  try {
    if (!isRecord(value)) return null
    onlyKeys(value, GRAPH_KEYS)
    if (value['protocolVersion'] !== TIA_PROTOCOL_VERSION) return null
    if (typeof value['complete'] !== 'boolean') return null
    const invalidators = optional(value, 'invalidators', (items) =>
      distinctBy(
        array(items, LIMITS.invalidators).map(invalidator),
        invalidatorKey,
      ),
    )
    const knownSources = optional(value, 'knownSources', (items) =>
      distinct(array(items, LIMITS.knownSources).map(projectPath)),
    )
    const graph: TiaImpactGraph = {
      complete: value['complete'],
      environmentFingerprint: boundedText(value['environmentFingerprint']),
      fingerprint: text(value['fingerprint']),
      ...(invalidators === undefined ? {} : { invalidators }),
      ...(knownSources === undefined ? {} : { knownSources }),
      observations: distinctObservations(
        array(value['observations'], LIMITS.observations).map(observation),
      ),
      protocolVersion: TIA_PROTOCOL_VERSION,
      suites: array(value['suites'], LIMITS.suites).map(suite),
    }
    checkReferences(graph)
    return graph
  } catch (error) {
    if (error instanceof Reject) return null
    throw error
  }
}
