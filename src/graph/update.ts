import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { GRAPH_SCHEMA_VERSION } from '../shared/constants.js'
import type {
  CachedTestResult,
  TiaCoverageMap,
  TiaRuntimeGraph,
  TiaTestEdge,
} from '../shared/types.js'

export interface GraphUpdateInput {
  collectionCoverage?: ReadonlyMap<string, TiaCoverageMap>
  executedFiles: Iterable<string>
  fallbackEdges?: ReadonlyMap<string, string[]>
  fullyExecutedFiles: Iterable<string>
  previous: TiaRuntimeGraph | null
  results: ReadonlyMap<string, CachedTestResult>
  root: string
  testCoverage?: ReadonlyMap<string, TiaCoverageMap>
  testEdges: ReadonlyMap<string, TiaTestEdge>
}

export function emptyGraph(): TiaRuntimeGraph {
  return {
    baseline: { sha: '', workingTree: {} },
    collectionCoverage: {},
    complete: false,
    coverageComplete: false,
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

export function updateGraph(input: GraphUpdateInput): TiaRuntimeGraph {
  const graph =
    input.previous === null
      ? emptyGraph()
      : structuredClone(input.previous)
  const executedFiles = new Set(input.executedFiles)

  for (const file of input.fullyExecutedFiles) {
    deleteFileRecords(graph, file)
  }

  for (const [id, result] of input.results) {
    graph.results[id] = structuredClone(result)
  }
  for (const [id, edge] of input.testEdges) {
    graph.testEdges[id] = structuredClone(edge)
  }
  for (const [id, coverage] of input.testCoverage ?? []) {
    graph.testCoverage[id] = structuredClone(coverage)
  }

  for (const file of executedFiles) {
    if (input.collectionCoverage !== undefined) {
      graph.collectionCoverage[file] = structuredClone(
        input.collectionCoverage.get(file) ?? {},
      )
    }

    const dependencies = Object.values(graph.testEdges)
      .filter((edge) => edge.file === file)
      .flatMap((edge) => edge.files)
    graph.edges[file] =
      dependencies.length === 0
        ? structuredClone(
            input.fallbackEdges?.get(file) ??
              graph.edges[file] ??
              [file],
          )
        : [...new Set([file, ...dependencies])].sort()
  }

  for (const testFile of Object.keys(graph.edges)) {
    if (!existsSync(resolve(input.root, testFile))) {
      delete graph.edges[testFile]
      delete graph.collectionCoverage[testFile]
      deleteFileRecords(graph, testFile)
    }
  }

  graph.schema = GRAPH_SCHEMA_VERSION
  return graph
}
