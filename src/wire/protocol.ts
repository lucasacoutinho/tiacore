import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'

import { invalidatorKey, observationKey } from '../core/canonical.ts'
import { normalizePath } from '../core/path.ts'
import {
  TIA_PROTOCOL_LIMITS as LIMITS,
  TIA_PROTOCOL_VERSION,
} from '../core/protocol.ts'

const atMost = (limit: number) =>
  Schema.isMaxLength(limit, { message: `exceeds the limit of ${limit}` })

const notBlank = Schema.makeFilter(
  (value: string) => value.trim() !== '' || 'must not be empty',
)

/** Protocol text: non-blank and bounded. */
export const Text = Schema.String.check(notBlank, atMost(LIMITS.stringLength))

const BoundedText = Schema.String.check(atMost(LIMITS.stringLength))

const projectRelative = Schema.makeFilter(
  (value: string) =>
    normalizePath(value)._tag === 'Accepted' ||
    `must be project-relative: ${value}`,
)

function canonicalPath(value: string): string {
  const result = normalizePath(value)
  return result._tag === 'Accepted' ? result.path : value
}

/** A project-relative path, decoded to its canonical form. */
export const ProjectPath = Schema.String.check(
  atMost(LIMITS.pathLength),
  projectRelative,
).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(canonicalPath),
    encode: SchemaGetter.passthrough(),
  }),
)

function uniqueBy<T>(key: (value: T) => string) {
  return Schema.makeFilter((values: readonly T[]) => {
    const keys = new Set<string>()
    for (const value of values) {
      const valueKey = key(value)
      if (keys.has(valueKey)) return 'contains duplicate values'
      keys.add(valueKey)
    }
    return undefined
  })
}

/** A bounded array of distinct strings. */
function distinctStrings(item: Schema.Codec<string, string>, limit: number) {
  return Schema.mutable(Schema.Array(item)).check(
    atMost(limit),
    uniqueBy((value: string) => value),
  )
}

/** A bounded array whose elements are distinct by `key`. */
function distinctRecords<S extends Schema.Top>(
  item: S,
  limit: number,
  key: (value: S['Type']) => string,
) {
  return Schema.mutable(Schema.Array(item)).check(atMost(limit), uniqueBy(key))
}

export const EdgeKind = Schema.Literals([
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

export const EdgeConfidence = Schema.Literals([
  'conservative',
  'exact',
  'inferred',
  'observed',
])

export const SuiteDescriptor = Schema.Struct({
  adapter: Text,
  dependsOn: Schema.optionalKey(
    distinctStrings(Text, LIMITS.relationsPerSuite),
  ),
  file: ProjectPath,
  id: Text,
  project: Text,
  resourceLocks: Schema.optionalKey(
    distinctStrings(Text, LIMITS.relationsPerSuite),
  ),
  tags: Schema.optionalKey(distinctStrings(Text, LIMITS.relationsPerSuite)),
})

export const DependencyObservation = Schema.Struct({
  confidence: EdgeConfidence,
  kind: EdgeKind,
  source: ProjectPath,
  suiteId: Text,
})

export const Invalidator = Schema.Struct({ pattern: Text, reason: Text })

function suiteChecks(graph: {
  readonly observations: readonly { readonly suiteId: string }[]
  readonly suites: readonly {
    readonly dependsOn?: readonly string[]
    readonly id: string
  }[]
}): Schema.FilterOutput {
  const suites = new Map(graph.suites.map((suite) => [suite.id, suite]))
  for (const suite of graph.suites) {
    for (const dependency of suite.dependsOn ?? []) {
      if (!suites.has(dependency)) {
        return `suite ${suite.id} depends on unknown suite ${dependency}`
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const cycleThrough = (id: string): string | undefined => {
    if (visiting.has(id)) return id
    if (visited.has(id)) return undefined
    visiting.add(id)
    for (const dependency of suites.get(id)?.dependsOn ?? []) {
      const cycle = cycleThrough(dependency)
      if (cycle !== undefined) return cycle
    }
    visiting.delete(id)
    visited.add(id)
    return undefined
  }
  for (const id of suites.keys()) {
    const cycle = cycleThrough(id)
    if (cycle !== undefined) return `suite dependency cycle includes ${cycle}`
  }
  const unknown = graph.observations.find(
    (observation) => !suites.has(observation.suiteId),
  )
  return unknown === undefined
    ? undefined
    : `observation references unknown suite ${unknown.suiteId}`
}

export const ImpactGraph = Schema.Struct({
  protocolVersion: Schema.Literal(TIA_PROTOCOL_VERSION).annotate({
    message: 'is an unsupported TIA protocol version',
  }),
  complete: Schema.Boolean,
  environmentFingerprint: BoundedText,
  fingerprint: Text,
  invalidators: Schema.optionalKey(
    distinctRecords(Invalidator, LIMITS.invalidators, invalidatorKey),
  ),
  knownSources: Schema.optionalKey(
    distinctStrings(ProjectPath, LIMITS.knownSources),
  ),
  observations: distinctRecords(
    DependencyObservation,
    LIMITS.observations,
    observationKey,
  ),
  suites: distinctRecords(SuiteDescriptor, LIMITS.suites, (suite) => suite.id),
}).check(Schema.makeFilter(suiteChecks))

const Partition = Schema.Struct({
  group: Schema.optionalKey(Text),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}).check(
  Schema.makeFilter(
    (partition) =>
      partition.index <= partition.total ||
      'index and total must describe a one-based partition',
  ),
)

export const ArtifactEnvelope = Schema.Struct({
  adapter: Text,
  artifactId: Text,
  graph: ImpactGraph,
  partition: Schema.optionalKey(Partition),
  runId: Text,
})
