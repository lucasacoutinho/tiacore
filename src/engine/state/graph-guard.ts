import {
  GRAPH_SCHEMA_VERSION,
  type TiaRuntimeGraph,
} from '../../core/runtime.ts'

// A hand-written type guard for a graph read back from the store. It accepts
// exactly what `parseRuntimeGraph` (src/wire/runtime-graph.ts) accepts, which
// test/engine/state/graph-guard.test.ts checks differentially. It exists for
// speed: the store validates a 2,000-test graph on every run, and the Schema
// guard costs about 150 ms there against about 25 ms for this one.

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function everyValue(value: Json, test: (entry: unknown) => boolean): boolean {
  // Parsed JSON has no inherited enumerable keys, so for-in visits own keys.
  for (const key in value) {
    if (!test(value[key])) return false
  }
  return true
}

const isString = (value: unknown): value is string => typeof value === 'string'

function isCounters(value: unknown): boolean {
  if (!isRecord(value)) return false
  for (const key in value) {
    if (!Number.isSafeInteger(value[key])) return false
  }
  return true
}

function isBranchCounters(value: unknown): boolean {
  if (!isRecord(value)) return false
  for (const key in value) {
    const counts = value[key]
    if (!Array.isArray(counts)) return false
    for (let index = 0; index < counts.length; index += 1) {
      if (!Number.isSafeInteger(counts[index])) return false
    }
  }
  return true
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString)
}

function isTemplate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBranchCounters(value.b) &&
    isRecord(value.branchMap) &&
    isCounters(value.f) &&
    isRecord(value.fnMap) &&
    isCounters(value.s) &&
    isRecord(value.statementMap)
  )
}

/** Coverage records whose every hit names a map of the graph's own table. */
function isCoverageRecords(value: unknown, maps: Json): boolean {
  if (!isRecord(value)) return false
  for (const file in value) {
    const record = value[file]
    if (!isRecord(record)) return false
    for (const path in record) {
      const hits = record[path]
      if (
        !isRecord(hits) ||
        typeof hits.map !== 'string' ||
        !Object.hasOwn(maps, hits.map) ||
        !isBranchCounters(hits.b) ||
        !isCounters(hits.f) ||
        !isCounters(hits.s)
      ) {
        return false
      }
    }
  }
  return true
}

function isResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    (!('duration' in value) ||
      (typeof value.duration === 'number' &&
        Number.isFinite(value.duration))) &&
    isString(value.file) &&
    isString(value.fullName) &&
    isString(value.id) &&
    (value.state === 'passed' ||
      value.state === 'failed' ||
      value.state === 'skipped')
  )
}

function isTestEdge(value: unknown): boolean {
  return isRecord(value) && isString(value.file) && isStringList(value.files)
}

function isPartition(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { index, total } = value
  return (
    (!('group' in value) || isString(value.group)) &&
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 1 &&
    typeof total === 'number' &&
    Number.isInteger(total) &&
    total >= index
  )
}

function isBaseline(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.sha) &&
    (!('source' in value) ||
      value.source === 'filesystem' ||
      value.source === 'git') &&
    isRecord(value.workingTree) &&
    everyValue(value.workingTree, isString)
  )
}

/** True when `value` is a runtime graph of the current schema. */
export function isStoredGraph(value: unknown): value is TiaRuntimeGraph {
  if (
    !isRecord(value) ||
    value.schema !== GRAPH_SCHEMA_VERSION ||
    typeof value.complete !== 'boolean' ||
    typeof value.coverageComplete !== 'boolean' ||
    !isString(value.fingerprint) ||
    !isString(value.updatedAt) ||
    !isBaseline(value.baseline) ||
    ('partition' in value && !isPartition(value.partition)) ||
    !isRecord(value.edges) ||
    !everyValue(value.edges, isStringList) ||
    !isRecord(value.results) ||
    !everyValue(value.results, isResult) ||
    !isRecord(value.testEdges) ||
    !everyValue(value.testEdges, isTestEdge) ||
    !isRecord(value.coverageMaps) ||
    !everyValue(value.coverageMaps, isTemplate) ||
    !isCoverageRecords(value.collectionCoverage, value.coverageMaps) ||
    !isCoverageRecords(value.testCoverage, value.coverageMaps)
  ) {
    return false
  }
  return true
}
