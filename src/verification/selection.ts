import {
  STRUCTURAL_FILE_PATTERN,
  TEST_FILE_PATTERN,
} from '../shared/constants.js'
import type { CachedTestResult, TiaRuntimeGraph } from '../engine/types.js'
import type {
  TiaVerificationSelection,
  TiaVerificationSnapshot,
} from './types.js'

function runnableResults(
  graph: TiaRuntimeGraph,
): Map<string, CachedTestResult> {
  return new Map(
    Object.values(graph.results)
      .filter(
        (result) =>
          result.state !== 'skipped' && !result.id.startsWith('module:'),
      )
      .map((result) => [result.id, result]),
  )
}

function addToIndex(
  index: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const values = index.get(key) ?? new Set<string>()
  values.add(value)
  index.set(key, values)
}

function dependencyIndexes(graphs: TiaRuntimeGraph[]): {
  collectionFilesBySource: Map<string, Set<string>>
  testFilesById: Map<string, Set<string>>
  testIdsBySource: Map<string, Set<string>>
} {
  const collectionFilesBySource = new Map<string, Set<string>>()
  const testFilesById = new Map<string, Set<string>>()
  const testIdsBySource = new Map<string, Set<string>>()

  for (const graph of graphs) {
    for (const [testFile, sourceFiles] of Object.entries(graph.edges)) {
      for (const sourceFile of sourceFiles) {
        addToIndex(collectionFilesBySource, sourceFile, testFile)
      }
    }
    for (const [id, edge] of Object.entries(graph.testEdges)) {
      addToIndex(testFilesById, id, edge.file)
      for (const sourceFile of edge.files) {
        addToIndex(testIdsBySource, sourceFile, id)
      }
    }
  }

  return { collectionFilesBySource, testFilesById, testIdsBySource }
}

function addFileResults(
  expected: Set<string>,
  results: Map<string, CachedTestResult>,
  file: string,
): void {
  for (const result of results.values()) {
    if (result.file === file) expected.add(result.id)
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

/**
 * Independently derives the tests a selective phase had to execute. Both
 * graphs are evidence: the selective graph retains removed dependencies,
 * while the full graph reveals dependencies introduced by the change.
 */
export function auditVerificationSelection(
  selective: TiaVerificationSnapshot,
  full: TiaVerificationSnapshot,
): TiaVerificationSelection {
  const results = runnableResults(full.graph)
  const allTestIds = new Set(results.keys())
  const expected = new Set<string>()
  const indexes = dependencyIndexes([selective.graph, full.graph])
  const completeTestEdges = new Map<string, boolean>()

  for (const result of results.values()) {
    const files = indexes.testFilesById.get(result.id)
    const hasEdge = files?.has(result.file) === true
    completeTestEdges.set(
      result.file,
      (completeTestEdges.get(result.file) ?? true) && hasEdge,
    )
  }

  if (
    selective.plan.mode === 'record' ||
    selective.plan.changedFiles.some((file) =>
      STRUCTURAL_FILE_PATTERN.test(file),
    )
  ) {
    for (const id of allTestIds) expected.add(id)
  } else {
    for (const result of Object.values(selective.graph.results)) {
      if (result.state === 'failed' && allTestIds.has(result.id)) {
        expected.add(result.id)
      }
    }

    for (const file of selective.plan.wholeTestFiles) {
      addFileResults(expected, results, file)
    }

    for (const file of selective.plan.changedFiles) {
      if (TEST_FILE_PATTERN.test(file)) {
        // A deleted test file has no current results and requires no work.
        addFileResults(expected, results, file)
        continue
      }

      const linkedIds = indexes.testIdsBySource.get(file) ?? new Set()
      for (const id of linkedIds) {
        if (allTestIds.has(id)) expected.add(id)
      }

      const linkedFiles = indexes.collectionFilesBySource.get(file) ?? new Set()
      for (const testFile of linkedFiles) {
        const preciseIds = [...linkedIds].filter(
          (id) => indexes.testFilesById.get(id)?.has(testFile) === true,
        )
        if (
          preciseIds.length === 0 ||
          completeTestEdges.get(testFile) !== true
        ) {
          addFileResults(expected, results, testFile)
        }
      }

      // Strict verification cannot prove that an unknown change is safe to
      // ignore. Treat it as suite-wide until there is independent evidence.
      if (linkedIds.size === 0 && linkedFiles.size === 0) {
        for (const id of allTestIds) expected.add(id)
      }
    }
  }

  const executed = new Set(
    selective.executedTestIds.filter((id) => allTestIds.has(id)),
  )
  const expectedTestIds = [...expected].sort()
  const executedTestIds = [...executed].sort()
  const missedTestIds = expectedTestIds.filter((id) => !executed.has(id))
  const unnecessaryTestIds = executedTestIds.filter((id) => !expected.has(id))
  const relevantExecuted = executedTestIds.length - unnecessaryTestIds.length

  return {
    changedFiles: [...selective.plan.changedFiles].sort(),
    executedTestIds,
    expectedTestIds,
    falseNegativeRate: rate(missedTestIds.length, expectedTestIds.length),
    missedTestIds,
    precision:
      executedTestIds.length === 0
        ? null
        : relevantExecuted / executedTestIds.length,
    unnecessaryTestIds,
  }
}
