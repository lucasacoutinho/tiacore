import type { FileCoverageData } from 'istanbul-lib-coverage'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'

import { GRAPH_SCHEMA_VERSION, type TiaRuntimeGraph } from '../core/runtime.ts'

const Count = Schema.Int.check(
  Schema.isBetween({
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: Number.MIN_SAFE_INTEGER,
  }),
)
const Counters = Schema.Record(Schema.String, Count)
const BranchCounters = Schema.Record(
  Schema.String,
  Schema.mutable(Schema.Array(Count)),
)

/** An Istanbul location table, kept opaque: tiacore stores it and never reads into it. */
function opaqueTable<T>() {
  return Schema.declare<T>(
    (value): value is T => Predicate.isObject(value) && !Array.isArray(value),
  )
}

const CoverageTemplate = Schema.Struct({
  b: BranchCounters,
  branchMap: opaqueTable<FileCoverageData['branchMap']>(),
  f: Counters,
  fnMap: opaqueTable<FileCoverageData['fnMap']>(),
  s: Counters,
  statementMap: opaqueTable<FileCoverageData['statementMap']>(),
})

const CoverageHits = Schema.Struct({
  b: BranchCounters,
  f: Counters,
  map: Schema.String,
  s: Counters,
})
const CoverageRecord = Schema.Record(Schema.String, CoverageHits)

const CachedTestResult = Schema.Struct({
  duration: Schema.optionalKey(Schema.Finite),
  file: Schema.String,
  fullName: Schema.String,
  id: Schema.String,
  state: Schema.Literals(['passed', 'failed', 'skipped']),
})

const Partition = Schema.Struct({
  group: Schema.optionalKey(Schema.String),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  total: Schema.Int,
}).check(Schema.makeFilter((partition) => partition.total >= partition.index))

function coverageMapsResolve(graph: {
  readonly collectionCoverage: Readonly<
    Record<string, Readonly<Record<string, { readonly map: string }>>>
  >
  readonly coverageMaps: Readonly<Record<string, unknown>>
  readonly testCoverage: Readonly<
    Record<string, Readonly<Record<string, { readonly map: string }>>>
  >
}): boolean {
  for (const records of [graph.collectionCoverage, graph.testCoverage]) {
    for (const record of Object.values(records)) {
      for (const hits of Object.values(record)) {
        if (!Object.hasOwn(graph.coverageMaps, hits.map)) return false
      }
    }
  }
  return true
}

export const RuntimeGraph = Schema.Struct({
  baseline: Schema.Struct({
    sha: Schema.String,
    source: Schema.optionalKey(Schema.Literals(['filesystem', 'git'])),
    workingTree: Schema.Record(Schema.String, Schema.String),
  }),
  collectionCoverage: Schema.Record(Schema.String, CoverageRecord),
  complete: Schema.Boolean,
  coverageComplete: Schema.Boolean,
  coverageMaps: Schema.Record(Schema.String, CoverageTemplate),
  edges: Schema.Record(
    Schema.String,
    Schema.mutable(Schema.Array(Schema.String)),
  ),
  fingerprint: Schema.String,
  partition: Schema.optionalKey(Partition),
  results: Schema.Record(Schema.String, CachedTestResult),
  schema: Schema.Literal(GRAPH_SCHEMA_VERSION),
  testCoverage: Schema.Record(Schema.String, CoverageRecord),
  testEdges: Schema.Record(
    Schema.String,
    Schema.Struct({
      file: Schema.String,
      files: Schema.mutable(Schema.Array(Schema.String)),
    }),
  ),
  updatedAt: Schema.String,
}).check(Schema.makeFilter(coverageMapsResolve))

const isRuntimeGraph: (value: unknown) => value is TiaRuntimeGraph =
  Schema.is(RuntimeGraph)

/**
 * Returns the graph when `value` is a runtime graph of the current schema and
 * null otherwise, so that a stale or damaged cache is rebuilt, never trusted.
 */
export function parseRuntimeGraph(value: unknown): TiaRuntimeGraph | null {
  return isRuntimeGraph(value) ? value : null
}
