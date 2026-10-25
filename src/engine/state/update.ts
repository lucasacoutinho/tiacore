import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CachedTestResult,
  type TiaCoverageRecord,
  type TiaCoverageTemplate,
  type TiaRuntimeGraph,
  type TiaTestEdge,
} from '../../core/runtime.ts'
import { cloneGraph, pruneCoverageMaps } from './coverage.ts'

export interface GraphUpdateInput {
  readonly collectionCoverage?: ReadonlyMap<string, TiaCoverageRecord>
  readonly coverageMaps?: Readonly<Record<string, TiaCoverageTemplate>>
  readonly executedFiles: Iterable<string>
  readonly fallbackEdges?: ReadonlyMap<string, readonly string[]>
  readonly fullyExecutedFiles: Iterable<string>
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

  for (const file of new Set(input.executedFiles)) {
    if (input.collectionCoverage !== undefined) {
      graph.collectionCoverage[file] = input.collectionCoverage.get(file) ?? {}
    }
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
 * Sets the schema; the caller sets baseline, flags, fingerprint and time.
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
    deleteFileRecords(graph, file)
  }
  pruneCoverageMaps(graph)
  graph.schema = GRAPH_SCHEMA_VERSION
  return graph
})
