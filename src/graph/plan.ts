import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import picomatch from 'picomatch'

import {
  STRUCTURAL_FILE_PATTERN,
  TEST_FILE_PATTERN,
} from '../shared/constants.js'
import { changedFilesSince } from './baseline.js'
import type {
  NormalizedOptions,
  RunPlan,
  TiaRuntimeGraph,
} from '../shared/types.js'

interface PlanInput {
  cachePrefix: string
  coverageRequested?: boolean
  fingerprint: string
  graph: TiaRuntimeGraph | null
  ignoredPrefixes?: string[]
  options: NormalizedOptions
  root: string
}

function fullRun(reason: string, graph: TiaRuntimeGraph | null): RunPlan {
  return {
    affectedTestIds: [],
    affectedTests: [],
    changedFiles: [],
    graph,
    mode: 'record',
    reason,
    replayedTests: 0,
    wholeTestFiles: [],
  }
}

function replayedResultCount(
  graph: TiaRuntimeGraph,
  affectedIds: Set<string>,
  wholeFiles: Set<string>,
): number {
  return Object.values(graph.results).filter(
    (result) =>
      result.state !== 'failed' &&
      !affectedIds.has(result.id) &&
      !wholeFiles.has(result.file),
  ).length
}

export function createRunPlan(input: PlanInput): RunPlan {
  const {
    cachePrefix,
    coverageRequested = false,
    fingerprint,
    graph,
    ignoredPrefixes = [cachePrefix],
    options,
    root,
  } = input

  if (options.fresh) {
    return fullRun('fresh graph requested', graph)
  }

  if (graph === null) {
    return fullRun('no compatible graph found', null)
  }

  if (!graph.complete) {
    return fullRun('the previous graph is incomplete', graph)
  }

  if (coverageRequested && !graph.coverageComplete) {
    return fullRun('the cached coverage graph is incomplete', graph)
  }

  if (graph.fingerprint !== fingerprint) {
    return fullRun('project structure changed', graph)
  }

  const changedFiles = changedFilesSince(root, graph.baseline, ignoredPrefixes)

  if (changedFiles === null) {
    return fullRun('the recorded commit is unavailable', graph)
  }

  const affectedIds = new Set<string>()
  const affected = new Set<string>()
  const wholeFiles = new Set<string>()
  const ignoredUnknownChange = picomatch(options.ignoreChanges, { dot: true })
  const reverseEdges = new Map<string, string[]>()
  const reverseTestEdges = new Map<string, string[]>()
  const testFileById = new Map<string, string>()

  for (const [testFile, sourceFiles] of Object.entries(graph.edges)) {
    for (const sourceFile of sourceFiles) {
      const tests = reverseEdges.get(sourceFile) ?? []
      tests.push(testFile)
      reverseEdges.set(sourceFile, tests)
    }
  }

  for (const [id, edge] of Object.entries(graph.testEdges)) {
    testFileById.set(id, edge.file)
    for (const sourceFile of edge.files) {
      const tests = reverseTestEdges.get(sourceFile) ?? []
      tests.push(id)
      reverseTestEdges.set(sourceFile, tests)
    }
  }

  const completeTestEdges = new Map<string, boolean>()
  for (const result of Object.values(graph.results)) {
    if (result.state === 'skipped' || result.id.startsWith('module:')) {
      continue
    }
    if (!graph.testEdges[result.id]) {
      completeTestEdges.set(result.file, false)
    } else if (!completeTestEdges.has(result.file)) {
      completeTestEdges.set(result.file, true)
    }
  }

  for (const result of Object.values(graph.results)) {
    if (result.state === 'failed' && existsSync(resolve(root, result.file))) {
      affected.add(result.file)
      if (
        result.id.startsWith('module:') ||
        completeTestEdges.get(result.file) === false
      ) {
        wholeFiles.add(result.file)
      } else {
        affectedIds.add(result.id)
      }
    }
  }

  for (const file of changedFiles) {
    if (STRUCTURAL_FILE_PATTERN.test(file)) {
      return fullRun(`structural file changed: ${file}`, graph)
    }

    if (TEST_FILE_PATTERN.test(file)) {
      if (existsSync(resolve(root, file))) {
        affected.add(file)
        wholeFiles.add(file)
      }
      continue
    }

    const linkedTests = reverseEdges.get(file) ?? []
    for (const testFile of linkedTests) {
      if (existsSync(resolve(root, testFile))) {
        affected.add(testFile)
      }
    }

    const linkedTestIds = reverseTestEdges.get(file) ?? []
    for (const id of linkedTestIds) {
      const testFile = testFileById.get(id)
      if (testFile !== undefined && existsSync(resolve(root, testFile))) {
        affected.add(testFile)
        affectedIds.add(id)
      }
    }

    for (const testFile of linkedTests) {
      const preciseIds = linkedTestIds.filter(
        (id) => testFileById.get(id) === testFile,
      )
      if (
        preciseIds.length === 0 ||
        completeTestEdges.get(testFile) === false
      ) {
        wholeFiles.add(testFile)
      }
    }

    if (
      linkedTests.length === 0 &&
      !ignoredUnknownChange(file) &&
      options.onUnknownChange === 'full'
    ) {
      return fullRun(`changed file is unknown to the graph: ${file}`, graph)
    }
  }

  for (const file of wholeFiles) {
    for (const [id, testFile] of testFileById) {
      if (testFile === file) {
        affectedIds.delete(id)
      }
    }
  }

  const affectedTestIds = [...affectedIds].sort()
  const affectedTests = [...affected].sort()
  const wholeTestFiles = [...wholeFiles].sort()

  return {
    affectedTestIds,
    affectedTests,
    changedFiles,
    graph,
    mode: 'replay',
    reason:
      affectedTests.length === 0
        ? 'no affected test files'
        : `${affectedTestIds.length} affected test case${
            affectedTestIds.length === 1 ? '' : 's'
          } in ${affectedTests.length} test file${
            affectedTests.length === 1 ? '' : 's'
          }${
            wholeTestFiles.length === 0
              ? ''
              : `; ${wholeTestFiles.length} whole-file fallback${
                  wholeTestFiles.length === 1 ? '' : 's'
                }`
          }`,
    replayedTests: replayedResultCount(graph, affectedIds, wholeFiles),
    wholeTestFiles,
  }
}
