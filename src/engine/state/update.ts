import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type Baseline,
  type CachedTestResult,
  type RecordFamily,
  type TiaCoverageRecord,
  type TiaCoverageTemplate,
  type TiaRuntimeGraph,
  type TiaRuntimeGraphPartition,
  type TiaTestEdge,
} from '../../core/runtime.ts'
import { pruneCoverageMaps } from './coverage.ts'

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
  /**
   * Test files the caller saw on disk during this run (it ran or collected
   * them). They are not checked again; every other graph file is.
   */
  readonly presentFiles?: Iterable<string>
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

/**
 * The graph with copies of its record tables, so records can be added and
 * removed without touching `graph`. The records themselves are shared: an
 * update replaces a record it changes and never changes one in place. Sharing
 * them also lets the store recognise the records a commit left unchanged.
 */
function copyTables(graph: TiaRuntimeGraph): TiaRuntimeGraph {
  const tables: Pick<TiaRuntimeGraph, RecordFamily> = {
    collectionCoverage: { ...graph.collectionCoverage },
    collectionFiles: { ...graph.collectionFiles },
    coverageMaps: { ...graph.coverageMaps },
    edges: { ...graph.edges },
    results: { ...graph.results },
    testCoverage: { ...graph.testCoverage },
    testEdges: { ...graph.testEdges },
  }
  return { ...graph, ...tables }
}

function deleteFileRecords(
  graph: TiaRuntimeGraph,
  files: ReadonlySet<string>,
): void {
  if (files.size === 0) return
  const ids = new Set([
    ...Object.keys(graph.results),
    ...Object.keys(graph.testEdges),
  ])
  for (const id of ids) {
    if (
      (graph.results[id] !== undefined && files.has(graph.results[id].file)) ||
      (graph.testEdges[id] !== undefined && files.has(graph.testEdges[id].file))
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
 * is therefore still valid. Every test edge of the file (`ids`) gets the
 * collection.
 */
function updateCollection(
  graph: TiaRuntimeGraph,
  input: GraphUpdateInput,
  file: string,
  full: boolean,
  ids: readonly string[],
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
  for (const id of ids) {
    const edge = graph.testEdges[id]!
    graph.testEdges[id] = { ...edge, files: union(edge.files, collection) }
  }
}

function applyObservations(input: GraphUpdateInput): TiaRuntimeGraph {
  const graph =
    input.previous === null ? emptyGraph() : copyTables(input.previous)

  const fully = new Set(input.fullyExecutedFiles)
  deleteFileRecords(graph, fully)

  for (const [id, result] of input.results) {
    graph.results[id] = { ...result }
  }
  for (const [id, edge] of input.testEdges) {
    graph.testEdges[id] = { ...edge, files: [...edge.files] }
  }
  // Coverage records are owned by the caller's run and maps are immutable,
  // content-addressed values, so the graph adopts both without copying.
  Object.assign(graph.coverageMaps, input.coverageMaps)
  for (const [id, coverage] of input.testCoverage ?? []) {
    graph.testCoverage[id] = coverage
  }

  const executed = new Set(input.executedFiles)
  if (executed.size === 0) return graph
  const edgesByFile = new Map<string, string[]>()
  for (const [id, edge] of Object.entries(graph.testEdges)) {
    if (!executed.has(edge.file)) continue
    const ids = edgesByFile.get(edge.file)
    if (ids === undefined) edgesByFile.set(edge.file, [id])
    else ids.push(id)
  }
  for (const file of executed) {
    const ids = edgesByFile.get(file) ?? []
    updateCollection(graph, input, file, fully.has(file), ids)
    const dependencies = ids.flatMap((id) => graph.testEdges[id]!.files)
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
 * The previous graph is never mutated; the result shares its unchanged records.
 */
export const updateGraph = Effect.fnUntraced(function* (
  input: GraphUpdateInput,
) {
  const fs = yield* FileSystem.FileSystem
  const graph = applyObservations(input)
  const known = new Set(input.presentFiles)
  const files = Object.keys(graph.edges).filter((file) => !known.has(file))
  const present = yield* Effect.forEach(
    files,
    (file) =>
      fs
        .exists(resolve(input.root, file))
        .pipe(Effect.orElseSucceed(() => false)),
    { concurrency: 16 },
  )
  const missing = new Set<string>()
  for (const [index, file] of files.entries()) {
    if (present[index] === true) continue
    delete graph.edges[file]
    delete graph.collectionCoverage[file]
    delete graph.collectionFiles[file]
    missing.add(file)
  }
  deleteFileRecords(graph, missing)
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
