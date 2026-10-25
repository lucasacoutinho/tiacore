import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type Baseline,
  type CachedTestResult,
  type TiaCoverageRecord,
  type TiaCoverageTemplate,
  type TiaRuntimeGraph,
  type TiaRuntimeGraphPartition,
  type TiaTestEdge,
} from '../../core/runtime.ts'
import { cloneGraph, pruneCoverageMaps } from './coverage.ts'

/**
 * What a run states about the graph it leaves. Every field is required and
 * `updateGraph` applies all of them, so no field keeps the value of an earlier
 * run by accident.
 */
export interface GraphHeader {
  readonly baseline: Baseline
  readonly complete: boolean
  readonly coverageComplete: boolean
  readonly fingerprint: string
  /** Null for a run that is not one shard of a partitioned run. */
  readonly partition: TiaRuntimeGraphPartition | null
  readonly updatedAt: string
}

export interface GraphUpdateInput {
  readonly collectionCoverage?: ReadonlyMap<string, TiaCoverageRecord>
  /**
   * Per executed test file, the files its module load and hooks touched.
   * Runners that cannot separate them from test bodies leave this out.
   */
  readonly collectionFiles?: ReadonlyMap<string, readonly string[]>
  readonly coverageMaps?: Readonly<Record<string, TiaCoverageTemplate>>
  readonly executedFiles: Iterable<string>
  readonly fallbackEdges?: ReadonlyMap<string, readonly string[]>
  readonly fullyExecutedFiles: Iterable<string>
  readonly header: GraphHeader
  readonly previous: TiaRuntimeGraph | null
  readonly results: ReadonlyMap<string, CachedTestResult>
  readonly root: string
  readonly testCoverage?: ReadonlyMap<string, TiaCoverageRecord>
  readonly testEdges: ReadonlyMap<string, TiaTestEdge>
}

export function emptyGraph(): TiaRuntimeGraph {
  return {
    baseline: { sha: '', workingTree: {} },
    collectionCoverage: {},
    collectionFiles: {},
    complete: false,
    coverageComplete: false,
    coverageMaps: {},
    edges: {},
    fingerprint: '',
    results: {},
    schema: GRAPH_SCHEMA_VERSION,
    testCoverage: {},
    testEdges: {},
    updatedAt: '',
  }
}

function deleteFileRecords(graph: TiaRuntimeGraph, file: string): void {
  const ids = new Set([
    ...Object.keys(graph.results),
    ...Object.keys(graph.testEdges),
  ])
  for (const id of ids) {
    if (
      graph.results[id]?.file === file ||
      graph.testEdges[id]?.file === file
    ) {
      delete graph.results[id]
      delete graph.testEdges[id]
      delete graph.testCoverage[id]
    }
  }
}

function union(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())].sort(byCodeUnit)
}

function maxCounters(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Record<string, number> {
  const merged = { ...left }
  for (const [id, count] of Object.entries(right)) {
    merged[id] = Math.max(merged[id] ?? 0, count)
  }
  return merged
}

/**
 * The collection coverage a partial run leaves: per source file, the counters
 * either run advanced when both used the same static map, the new record when
 * the file's map changed, and the old record when this run did not reach it.
 */
function mergeCollectionCoverage(
  previous: TiaCoverageRecord,
  observed: TiaCoverageRecord,
): TiaCoverageRecord {
  const merged: TiaCoverageRecord = { ...previous }
  for (const [path, hits] of Object.entries(observed)) {
    const old = merged[path]
    if (old === undefined || old.map !== hits.map) {
      merged[path] = hits
      continue
    }
    const b: Record<string, number[]> = { ...old.b }
    for (const [id, counts] of Object.entries(hits.b)) {
      const before = b[id] ?? []
      b[id] = counts.map((count, index) => Math.max(count, before[index] ?? 0))
    }
    merged[path] = {
      b,
      f: maxCounters(old.f, hits.f),
      map: hits.map,
      s: maxCounters(old.s, hits.s),
    }
  }
  return merged
}

/**
 * Updates a test file's collection evidence (proofs/Tia/Update.lean). A file
 * whose every test ran replaces it with what the run observed. A file with
 * replayed tests keeps the previous evidence and adds the new: a change to any
 * collection file selects every test of the file (each test edge contains the
 * collection), so a replayed test means none of them changed. Collection that
 * a partial run does not reach, such as a layer built only by replayed tests,
 * is therefore still valid. Every test edge of the file gets the collection.
 */
function updateCollection(
  graph: TiaRuntimeGraph,
  input: GraphUpdateInput,
  file: string,
  full: boolean,
): void {
  const observedCoverage = input.collectionCoverage?.get(file) ?? {}
  if (input.collectionCoverage !== undefined) {
    graph.collectionCoverage[file] = full
      ? observedCoverage
      : mergeCollectionCoverage(
          graph.collectionCoverage[file] ?? {},
          observedCoverage,
        )
  }
  if (input.collectionFiles === undefined) return
  const observed = input.collectionFiles.get(file) ?? []
  const collection = full
    ? union(observed)
    : union(graph.collectionFiles[file] ?? [], observed)
  if (collection.length === 0) {
    delete graph.collectionFiles[file]
    return
  }
  graph.collectionFiles[file] = collection
  for (const edge of Object.values(graph.testEdges)) {
    if (edge.file === file) edge.files = union(edge.files, collection)
  }
}

function applyObservations(input: GraphUpdateInput): TiaRuntimeGraph {
  const graph =
    input.previous === null ? emptyGraph() : cloneGraph(input.previous)

  for (const file of input.fullyExecutedFiles) deleteFileRecords(graph, file)

  for (const [id, result] of input.results) {
    graph.results[id] = structuredClone(result)
  }
  for (const [id, edge] of input.testEdges) {
    graph.testEdges[id] = structuredClone(edge)
  }
  // Coverage records are owned by the caller's run and maps are immutable,
  // content-addressed values, so the graph adopts both without copying.
  Object.assign(graph.coverageMaps, input.coverageMaps)
  for (const [id, coverage] of input.testCoverage ?? []) {
    graph.testCoverage[id] = coverage
  }

  const fully = new Set(input.fullyExecutedFiles)
  for (const file of new Set(input.executedFiles)) {
    updateCollection(graph, input, file, fully.has(file))
    const dependencies = Object.values(graph.testEdges)
      .filter((edge) => edge.file === file)
      .flatMap((edge) => edge.files)
    graph.edges[file] =
      dependencies.length === 0
        ? [...(input.fallbackEdges?.get(file) ?? graph.edges[file] ?? [file])]
        : [...new Set([file, ...dependencies])].sort(byCodeUnit)
  }
  return graph
}

/**
 * Folds one run's observations into the graph. Files that were fully executed
 * lose their old results first, tests that were not rerun keep theirs, and any
 * test file that no longer exists under `root` is pruned with its records.
 * Stamps the graph with the schema and the input's header.
 * The previous graph is never mutated.
 */
export const updateGraph = Effect.fnUntraced(function* (
  input: GraphUpdateInput,
) {
  const fs = yield* FileSystem.FileSystem
  const graph = applyObservations(input)
  const files = Object.keys(graph.edges)
  const present = yield* Effect.forEach(
    files,
    (file) =>
      fs
        .exists(resolve(input.root, file))
        .pipe(Effect.orElseSucceed(() => false)),
    { concurrency: 16 },
  )
  for (const [index, file] of files.entries()) {
    if (present[index] === true) continue
    delete graph.edges[file]
    delete graph.collectionCoverage[file]
    delete graph.collectionFiles[file]
    deleteFileRecords(graph, file)
  }
  pruneCoverageMaps(graph)
  const { header } = input
  graph.baseline = header.baseline
  graph.complete = header.complete
  graph.coverageComplete = header.coverageComplete
  graph.fingerprint = header.fingerprint
  if (header.partition === null) delete graph.partition
  else graph.partition = structuredClone(header.partition)
  graph.schema = GRAPH_SCHEMA_VERSION
  graph.updatedAt = header.updatedAt
  return graph
})
