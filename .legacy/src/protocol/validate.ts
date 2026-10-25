import { normalizeProtocolPath, normalizeProtocolPaths } from './paths.js'
import {
  TIA_PROTOCOL_VERSION,
  type TiaArtifactEnvelope,
  type TiaDependencyObservation,
  type TiaImpactGraph,
  type TiaInvalidator,
  type TiaSuiteDescriptor,
} from './types.js'

export const TIA_PROTOCOL_LIMITS = Object.freeze({
  invalidators: 10_000,
  knownSources: 1_000_000,
  observations: 1_000_000,
  pathLength: 4_096,
  relationsPerSuite: 100_000,
  stringLength: 8_192,
  suites: 100_000,
})

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
const GRAPH_KEYS = new Set([
  'complete',
  'environmentFingerprint',
  'fingerprint',
  'invalidators',
  'knownSources',
  'observations',
  'protocolVersion',
  'suites',
])
const SUITE_KEYS = new Set([
  'adapter',
  'dependsOn',
  'file',
  'id',
  'project',
  'resourceLocks',
  'tags',
])
const OBSERVATION_KEYS = new Set(['confidence', 'kind', 'source', 'suiteId'])
const INVALIDATOR_KEYS = new Set(['pattern', 'reason'])
const ENVELOPE_KEYS = new Set([
  'adapter',
  'artifactId',
  'graph',
  'partition',
  'runId',
])
const PARTITION_KEYS = new Set(['group', 'index', 'total'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function knownKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key))
  if (unknown !== undefined) {
    throw new Error(`${label} has an unknown field: ${unknown}`)
  }
}

function boundedArray(value: unknown, limit: number, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  if (value.length > limit) {
    throw new Error(`${label} exceeds the limit of ${limit}`)
  }
  return value
}

function text(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean; limit?: number } = {},
): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`)
  }
  if (options.allowEmpty !== true && value.trim() === '') {
    throw new Error(`${label} must not be empty`)
  }
  const limit = options.limit ?? TIA_PROTOCOL_LIMITS.stringLength
  if (value.length > limit) {
    throw new Error(`${label} exceeds the limit of ${limit}`)
  }
  return value
}

function path(value: unknown, label: string): string {
  return normalizeProtocolPath(
    text(value, label, { limit: TIA_PROTOCOL_LIMITS.pathLength }),
  )
}

function stringArray(
  value: unknown,
  label: string,
  options: { paths?: boolean } = {},
): string[] {
  const array = boundedArray(
    value,
    TIA_PROTOCOL_LIMITS.relationsPerSuite,
    label,
  )
  const values = array.map((item, index) =>
    options.paths === true
      ? path(item, `${label}[${index}]`)
      : text(item, `${label}[${index}]`),
  )
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate values`)
  }
  return [...values].sort()
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, label)
}

function suite(value: unknown, index: number): TiaSuiteDescriptor {
  const parsed = record(value, `TIA suite ${index}`)
  knownKeys(parsed, SUITE_KEYS, `TIA suite ${index}`)
  const result: TiaSuiteDescriptor = {
    adapter: text(parsed.adapter, `TIA suite ${index} adapter`),
    file: path(parsed.file, `TIA suite ${index} file`),
    id: text(parsed.id, `TIA suite ${index} id`),
    project: text(parsed.project, `TIA suite ${index} project`),
  }
  const dependsOn = optionalStringArray(
    parsed.dependsOn,
    `TIA suite ${result.id} dependsOn`,
  )
  const resourceLocks = optionalStringArray(
    parsed.resourceLocks,
    `TIA suite ${result.id} resourceLocks`,
  )
  const tags = optionalStringArray(parsed.tags, `TIA suite ${result.id} tags`)
  if (dependsOn !== undefined) result.dependsOn = dependsOn
  if (resourceLocks !== undefined) result.resourceLocks = resourceLocks
  if (tags !== undefined) result.tags = tags
  return result
}

function observation(value: unknown, index: number): TiaDependencyObservation {
  const parsed = record(value, `TIA observation ${index}`)
  knownKeys(parsed, OBSERVATION_KEYS, `TIA observation ${index}`)
  const kind = text(parsed.kind, `TIA observation ${index} kind`)
  const confidence = text(
    parsed.confidence,
    `TIA observation ${index} confidence`,
  )
  if (!EDGE_KINDS.has(kind)) {
    throw new Error(`TIA observation ${index} has an unsupported kind: ${kind}`)
  }
  if (!EDGE_CONFIDENCES.has(confidence)) {
    throw new Error(
      `TIA observation ${index} has an unsupported confidence: ${confidence}`,
    )
  }
  return {
    confidence: confidence as TiaDependencyObservation['confidence'],
    kind: kind as TiaDependencyObservation['kind'],
    source: path(parsed.source, `TIA observation ${index} source`),
    suiteId: text(parsed.suiteId, `TIA observation ${index} suiteId`),
  }
}

function invalidator(value: unknown, index: number): TiaInvalidator {
  const parsed = record(value, `TIA invalidator ${index}`)
  knownKeys(parsed, INVALIDATOR_KEYS, `TIA invalidator ${index}`)
  return {
    pattern: text(parsed.pattern, `TIA invalidator ${index} pattern`),
    reason: text(parsed.reason, `TIA invalidator ${index} reason`),
  }
}

function rejectDuplicates<T>(
  values: readonly T[],
  label: string,
  serialize: (value: T) => string = JSON.stringify,
): void {
  const keys = values.map(serialize)
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label} contains duplicate values`)
  }
}

function assertAcyclic(suites: ReadonlyMap<string, TiaSuiteDescriptor>): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(suiteId: string): void {
    if (visiting.has(suiteId)) {
      throw new Error(`TIA suite dependency cycle includes ${suiteId}`)
    }
    if (visited.has(suiteId)) return
    visiting.add(suiteId)
    for (const dependency of suites.get(suiteId)?.dependsOn ?? []) {
      visit(dependency)
    }
    visiting.delete(suiteId)
    visited.add(suiteId)
  }

  for (const suiteId of suites.keys()) visit(suiteId)
}

export function parseImpactGraph(value: unknown): TiaImpactGraph {
  const parsed = record(value, 'TIA impact graph')
  knownKeys(parsed, GRAPH_KEYS, 'TIA impact graph')
  if (parsed.protocolVersion !== TIA_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported TIA protocol version: ${String(parsed.protocolVersion)}`,
    )
  }
  if (typeof parsed.complete !== 'boolean') {
    throw new Error('TIA impact graph complete must be a boolean')
  }

  const suites = boundedArray(
    parsed.suites,
    TIA_PROTOCOL_LIMITS.suites,
    'TIA impact graph suites',
  )
    .map(suite)
    .sort((left, right) => left.id.localeCompare(right.id))
  const suiteMap = new Map<string, TiaSuiteDescriptor>()
  for (const candidate of suites) {
    if (suiteMap.has(candidate.id)) {
      throw new Error(
        `TIA impact graph has a duplicate suite id: ${candidate.id}`,
      )
    }
    suiteMap.set(candidate.id, candidate)
  }
  for (const candidate of suites) {
    for (const dependency of candidate.dependsOn ?? []) {
      if (!suiteMap.has(dependency)) {
        throw new Error(
          `TIA suite ${candidate.id} depends on unknown suite ${dependency}`,
        )
      }
    }
  }
  assertAcyclic(suiteMap)

  const observations = boundedArray(
    parsed.observations,
    TIA_PROTOCOL_LIMITS.observations,
    'TIA impact graph observations',
  )
    .map(observation)
    .sort((left, right) =>
      `${left.suiteId}\0${left.source}\0${left.kind}\0${left.confidence}`.localeCompare(
        `${right.suiteId}\0${right.source}\0${right.kind}\0${right.confidence}`,
      ),
    )
  rejectDuplicates(observations, 'TIA impact graph observations')
  for (const candidate of observations) {
    if (!suiteMap.has(candidate.suiteId)) {
      throw new Error(
        `TIA observation references unknown suite ${candidate.suiteId}`,
      )
    }
  }

  const knownSourceValues =
    parsed.knownSources === undefined
      ? undefined
      : boundedArray(
          parsed.knownSources,
          TIA_PROTOCOL_LIMITS.knownSources,
          'TIA impact graph knownSources',
        ).map((source, index) =>
          path(source, `TIA impact graph knownSources[${index}]`),
        )
  const knownSources =
    knownSourceValues === undefined
      ? undefined
      : normalizeProtocolPaths(knownSourceValues)
  if (
    knownSources !== undefined &&
    knownSources.length !== knownSourceValues?.length
  ) {
    throw new Error('TIA impact graph knownSources contains duplicate values')
  }

  const invalidators =
    parsed.invalidators === undefined
      ? undefined
      : boundedArray(
          parsed.invalidators,
          TIA_PROTOCOL_LIMITS.invalidators,
          'TIA impact graph invalidators',
        )
          .map(invalidator)
          .sort((left, right) =>
            `${left.pattern}\0${left.reason}`.localeCompare(
              `${right.pattern}\0${right.reason}`,
            ),
          )
  if (invalidators !== undefined) {
    rejectDuplicates(invalidators, 'TIA impact graph invalidators')
  }

  return {
    complete: parsed.complete,
    environmentFingerprint: text(
      parsed.environmentFingerprint,
      'TIA impact graph environmentFingerprint',
      { allowEmpty: true },
    ),
    fingerprint: text(parsed.fingerprint, 'TIA impact graph fingerprint'),
    ...(invalidators === undefined ? {} : { invalidators }),
    ...(knownSources === undefined ? {} : { knownSources }),
    observations,
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites,
  }
}

export function parseArtifactEnvelope(value: unknown): TiaArtifactEnvelope {
  const parsed = record(value, 'TIA artifact envelope')
  knownKeys(parsed, ENVELOPE_KEYS, 'TIA artifact envelope')
  const partitionValue = parsed.partition
  let partition: TiaArtifactEnvelope['partition']
  if (partitionValue !== undefined) {
    const candidate = record(partitionValue, 'TIA artifact partition')
    knownKeys(candidate, PARTITION_KEYS, 'TIA artifact partition')
    if (
      !Number.isSafeInteger(candidate.index) ||
      !Number.isSafeInteger(candidate.total) ||
      (candidate.index as number) < 1 ||
      (candidate.total as number) < 1 ||
      (candidate.index as number) > (candidate.total as number)
    ) {
      throw new Error(
        'TIA artifact partition index and total must describe a one-based partition',
      )
    }
    partition = {
      ...(candidate.group === undefined
        ? {}
        : { group: text(candidate.group, 'TIA artifact partition group') }),
      index: candidate.index as number,
      total: candidate.total as number,
    }
  }

  return {
    adapter: text(parsed.adapter, 'TIA artifact adapter'),
    artifactId: text(parsed.artifactId, 'TIA artifact id'),
    graph: parseImpactGraph(parsed.graph),
    ...(partition === undefined ? {} : { partition }),
    runId: text(parsed.runId, 'TIA artifact run id'),
  }
}
