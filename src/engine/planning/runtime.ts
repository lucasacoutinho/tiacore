import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import picomatch from 'picomatch'

import {
  STRUCTURAL_FILE_PATTERN,
  TEST_FILE_PATTERN,
} from '../../shared/constants.js'
import { changedFilesSince } from '../baseline/capture.js'
import type {
  RunPlan,
  RunPlanBaseline,
  RunPlanDecision,
  RuntimePlanOptions,
  TiaRuntimeGraph,
} from '../types.js'

interface PlanInput {
  baseline?: RunPlanBaseline
  cachePrefix: string
  coverageRequested?: boolean
  fingerprint: string
  graph: TiaRuntimeGraph | null
  ignoredPrefixes?: string[]
  options: RuntimePlanOptions
  root: string
  testFiles?: string[]
}

type DecisionTarget =
  | { target: 'run' }
  | { file: string; target: 'test-file' }
  | { file: string; id: string; target: 'test-case' }

type DecisionAccumulator = DecisionTarget & {
  reasons: Set<string>
}

function defaultBaseline(graph: TiaRuntimeGraph | null): RunPlanBaseline {
  if (graph === null) {
    return {
      origin: 'none',
      reason: 'no graph supplied to the planner',
      sha: null,
      source: null,
    }
  }

  return {
    origin: 'local',
    reason: 'graph supplied directly to the planner',
    sha: graph.baseline.sha || null,
    source: graph.baseline.source ?? null,
  }
}

function addDecision(
  decisions: Map<string, DecisionAccumulator>,
  decision: DecisionTarget,
  reason: string,
): void {
  const file = 'file' in decision ? decision.file : ''
  const id = 'id' in decision ? decision.id : ''
  const key = `${decision.target}\0${file}\0${id}`
  const current = decisions.get(key) ?? {
    ...decision,
    reasons: new Set<string>(),
  }
  current.reasons.add(reason)
  decisions.set(key, current)
}

function finalizeDecisions(
  decisions: Map<string, DecisionAccumulator>,
  affectedIds?: ReadonlySet<string>,
): RunPlanDecision[] {
  return [...decisions.values()]
    .filter(
      (decision) =>
        decision.target !== 'test-case' ||
        affectedIds === undefined ||
        affectedIds.has(decision.id),
    )
    .map((decision): RunPlanDecision => {
      const reasons = [...decision.reasons].sort()
      if (decision.target === 'run') {
        return { reasons, target: 'run' }
      }
      if (decision.target === 'test-case') {
        return {
          file: decision.file,
          id: decision.id,
          reasons,
          target: 'test-case',
        }
      }
      return {
        file: decision.file,
        reasons,
        target: 'test-file',
      }
    })
    .sort((left, right) => {
      const leftFile = 'file' in left ? left.file : ''
      const rightFile = 'file' in right ? right.file : ''
      const leftId = 'id' in left ? left.id : ''
      const rightId = 'id' in right ? right.id : ''
      return `${left.target}\0${leftFile}\0${leftId}`.localeCompare(
        `${right.target}\0${rightFile}\0${rightId}`,
      )
    })
}

function fullRun(
  reason: string,
  graph: TiaRuntimeGraph | null,
  baseline: RunPlanBaseline,
  changedFiles: string[] = [],
): RunPlan {
  return {
    affectedTestIds: [],
    affectedTests: [],
    baseline,
    changedFiles,
    decisions: [{ reasons: [reason], target: 'run' }],
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
  const baseline = input.baseline ?? defaultBaseline(graph)

  if (options.fresh) {
    return fullRun('fresh graph requested', graph, baseline)
  }

  if (graph === null) {
    return fullRun('no compatible graph found', null, baseline)
  }

  if (!graph.complete) {
    return fullRun('the previous graph is incomplete', graph, baseline)
  }

  if (coverageRequested && !graph.coverageComplete) {
    return fullRun(
      'the cached coverage graph is incomplete',
      graph,
      baseline,
    )
  }

  if (graph.fingerprint !== fingerprint) {
    return fullRun('project structure changed', graph, baseline)
  }

  const changedFiles = changedFilesSince(root, graph.baseline, ignoredPrefixes)

  if (changedFiles === null) {
    return fullRun('the recorded commit is unavailable', graph, baseline)
  }

  const affectedIds = new Set<string>()
  const affected = new Set<string>()
  const decisions = new Map<string, DecisionAccumulator>()
  const wholeFiles = new Set<string>()
  const ignoredUnknownChange = picomatch(options.ignoreChanges, { dot: true })
  const directTestFile =
    input.testFiles === undefined
      ? null
      : picomatch(input.testFiles, { dot: true })
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
      const failedReason = `previous test failed: ${result.fullName}`
      if (
        result.id.startsWith('module:') ||
        completeTestEdges.get(result.file) === false
      ) {
        wholeFiles.add(result.file)
        addDecision(
          decisions,
          { file: result.file, target: 'test-file' },
          failedReason,
        )
      } else {
        affectedIds.add(result.id)
        addDecision(
          decisions,
          {
            file: result.file,
            id: result.id,
            target: 'test-case',
          },
          failedReason,
        )
      }
    }
  }

  for (const file of changedFiles) {
    if (STRUCTURAL_FILE_PATTERN.test(file)) {
      return fullRun(
        `structural file changed: ${file}`,
        graph,
        baseline,
        changedFiles,
      )
    }

    const isTestFile = TEST_FILE_PATTERN.test(file)
    if (isTestFile && (directTestFile === null || directTestFile(file))) {
      if (existsSync(resolve(root, file))) {
        affected.add(file)
        wholeFiles.add(file)
        addDecision(
          decisions,
          { file, target: 'test-file' },
          `test file changed: ${file}`,
        )
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
        addDecision(
          decisions,
          { file: testFile, id, target: 'test-case' },
          `observed dependency changed: ${file}`,
        )
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
        addDecision(
          decisions,
          { file: testFile, target: 'test-file' },
          `observed dependency changed: ${file}`,
        )
        addDecision(
          decisions,
          { file: testFile, target: 'test-file' },
          `test-level dependency metadata is incomplete for change: ${file}`,
        )
      }
    }

    if (
      linkedTests.length === 0 &&
      !isTestFile &&
      !ignoredUnknownChange(file) &&
      options.onUnknownChange === 'full'
    ) {
      return fullRun(
        `changed file is unknown to the graph: ${file}`,
        graph,
        baseline,
        changedFiles,
      )
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
    baseline,
    changedFiles,
    decisions: finalizeDecisions(decisions, affectedIds),
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
