import * as Match from 'effect/Match'

import { byCodeUnit } from '../../core/canonical.ts'
import type {
  CachedTestResult,
  RunPlan,
  RunPlanBaseline,
  RunPlanDecision,
  RuntimePlanOptions,
  TiaRuntimeGraph,
} from '../../core/runtime.ts'
import {
  select,
  type GroupReason,
  type ItemReason,
  type SelectionGroup,
  type SelectionItem,
} from '../../core/select.ts'
import { globMatcher } from '../glob.ts'

export const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/u

export const STRUCTURAL_FILE_PATTERN =
  /^(?:package\.json|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)|(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json|(?:vite|vitest)(?:\.[^.]+)?\.config\.[cm]?[jt]s)$/u

export interface RuntimePlanInput {
  readonly baseline: RunPlanBaseline
  readonly coverageRequested?: boolean
  readonly fingerprint: string
  readonly graph: TiaRuntimeGraph | null
  readonly options: RuntimePlanOptions
  /** Globs naming the test files this run may select directly; all when absent. */
  readonly testFiles?: readonly string[]
}

function fullRun(
  reason: string,
  input: RuntimePlanInput,
  changedFiles: string[] = [],
): RunPlan {
  return {
    affectedTestIds: [],
    affectedTests: [],
    baseline: input.baseline,
    changedFiles,
    decisions: [{ reasons: [reason], target: 'run' }],
    graph: input.graph,
    mode: 'record',
    reason,
    replayedTests: 0,
    wholeTestFiles: [],
  }
}

/**
 * The fail-safe gates that do not need change detection. Returns the full-run
 * plan when a gate trips, or null when the graph may be used for selection.
 */
export function gateRuntimePlan(input: RuntimePlanInput): RunPlan | null {
  const { graph } = input
  if (input.options.fresh) return fullRun('fresh graph requested', input)
  if (graph === null) return fullRun('no compatible graph found', input)
  if (!graph.complete) return fullRun('the previous graph is incomplete', input)
  if (input.coverageRequested === true && !graph.coverageComplete) {
    return fullRun('the cached coverage graph is incomplete', input)
  }
  if (graph.fingerprint !== input.fingerprint) {
    return fullRun('project structure changed', input)
  }
  return null
}

/** The plan when change detection is unavailable. */
export function changesUnavailablePlan(input: RuntimePlanInput): RunPlan {
  return fullRun('the recorded commit is unavailable', input)
}

/** Every test file the plan may need to know exists. */
export function runtimePlanCandidates(
  graph: TiaRuntimeGraph,
  changedFiles: readonly string[],
): string[] {
  const files = new Set<string>(Object.keys(graph.edges))
  for (const edge of Object.values(graph.testEdges)) files.add(edge.file)
  for (const result of Object.values(graph.results)) files.add(result.file)
  for (const file of changedFiles) {
    if (TEST_FILE_PATTERN.test(file)) files.add(file)
  }
  return [...files].sort(byCodeUnit)
}

/** Per test file: false when some executed case has no per-case edges. */
function exactFiles(graph: TiaRuntimeGraph): Map<string, boolean> {
  const exact = new Map<string, boolean>()
  for (const result of Object.values(graph.results)) {
    if (result.state === 'skipped' || result.id.startsWith('module:')) continue
    if (graph.testEdges[result.id] === undefined) exact.set(result.file, false)
    else if (!exact.has(result.file)) exact.set(result.file, true)
  }
  return exact
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Plans a run from the admitted graph and the files changed since its
 * baseline. `exists` reports which test files are present now; files that no
 * longer exist are never selected.
 */
export function planRuntimeChanges(
  input: RuntimePlanInput,
  changedFiles: readonly string[],
  exists: (file: string) => boolean,
): RunPlan {
  const graph = input.graph
  if (graph === null) return fullRun('no compatible graph found', input)
  const changes = [...changedFiles]
  const direct =
    input.testFiles === undefined ? () => true : globMatcher(input.testFiles)
  const ignored = globMatcher(input.options.ignoreChanges)
  const exact = exactFiles(graph)

  const failed = Object.values(graph.results).filter(
    (result) => result.state === 'failed' && exists(result.file),
  )
  const groupFailures = new Map<string, CachedTestResult[]>()
  const caseFailures = new Map<string, CachedTestResult>()
  for (const result of failed) {
    if (result.id.startsWith('module:') || exact.get(result.file) === false) {
      const failures = groupFailures.get(result.file)
      if (failures === undefined) groupFailures.set(result.file, [result])
      else failures.push(result)
    } else {
      caseFailures.set(result.id, result)
    }
  }

  const changedTestFiles = new Set(
    changes.filter((file) => TEST_FILE_PATTERN.test(file)),
  )
  const groups: SelectionGroup[] = runtimePlanCandidates(graph, changes)
    .filter(exists)
    .map((file) => {
      const selectsItself = changedTestFiles.has(file) && direct(file)
      const coarse = graph.edges[file] ?? []
      return {
        // A changed test file already selects itself, so its self edge adds nothing.
        coarse: selectsItself
          ? coarse.filter((source) => source !== file)
          : coarse,
        exact: exact.get(file) !== false,
        file: selectsItself ? file : undefined,
        key: file,
        rerun: groupFailures.has(file),
      }
    })
  const items: SelectionItem[] = Object.entries(graph.testEdges)
    .filter(([, edge]) => exists(edge.file))
    .map(([id, edge]) => ({
      deps: edge.files,
      group: edge.file,
      id,
      needs: [],
      rerun: caseFailures.has(id),
    }))

  const structural = new Map<string, string>()
  for (const file of changes) {
    if (STRUCTURAL_FILE_PATTERN.test(file)) {
      structural.set(file, 'structural file changed')
    }
  }
  const known = new Set<string>(Object.values(graph.edges).flat())
  for (const file of changes) {
    if (changedTestFiles.has(file) || ignored(file)) known.add(file)
  }

  const selection = select({
    changes,
    groups,
    items,
    known,
    onUnknown: input.options.onUnknownChange,
    structural,
  })
  if (selection._tag === 'Full') {
    const { cause } = selection
    return fullRun(
      cause._tag === 'Structural'
        ? `structural file changed: ${cause.path}`
        : `changed file is unknown to the graph: ${cause.path}`,
      input,
      changes,
    )
  }

  const wholeFiles = new Set(selection.groups)
  const affectedIds = selection.items.filter((id) => {
    const file = graph.testEdges[id]?.file
    return file !== undefined && !wholeFiles.has(file)
  })
  const affectedFiles = new Set(wholeFiles)
  for (const id of selection.items) {
    const file = graph.testEdges[id]?.file
    if (file !== undefined) affectedFiles.add(file)
  }

  const decisions: RunPlanDecision[] = []
  for (const file of wholeFiles) {
    const reasons = new Set<string>()
    for (const reason of selection.groupReasons.get(file) ?? []) {
      for (const text of groupReasonText(
        reason,
        groupFailures.get(file) ?? [],
      )) {
        reasons.add(text)
      }
    }
    decisions.push({
      file,
      reasons: [...reasons].sort(byCodeUnit),
      target: 'test-file',
    })
  }
  for (const id of affectedIds) {
    const file = graph.testEdges[id]?.file ?? ''
    const reasons = new Set<string>()
    for (const reason of selection.itemReasons.get(id) ?? []) {
      const text = itemReasonText(reason, caseFailures.get(id))
      if (text !== undefined) reasons.add(text)
    }
    decisions.push({
      file,
      id,
      reasons: [...reasons].sort(byCodeUnit),
      target: 'test-case',
    })
  }
  decisions.sort((left, right) =>
    byCodeUnit(decisionKey(left), decisionKey(right)),
  )

  // Results of test files that no longer exist are neither replayed nor counted.
  const results = Object.fromEntries(
    Object.entries(graph.results).filter(([, result]) => exists(result.file)),
  )
  const affectedSet = new Set(affectedIds)
  const replayedTests = Object.values(results).filter(
    (result) =>
      result.state !== 'failed' &&
      !affectedSet.has(result.id) &&
      !wholeFiles.has(result.file),
  ).length
  const affectedTests = [...affectedFiles].sort(byCodeUnit)
  const wholeTestFiles = [...wholeFiles].sort(byCodeUnit)

  return {
    affectedTestIds: affectedIds,
    affectedTests,
    baseline: input.baseline,
    changedFiles: changes,
    decisions,
    graph: { ...graph, results },
    mode: 'replay',
    reason:
      affectedTests.length === 0
        ? 'no affected test files'
        : `${plural(affectedIds.length, 'affected test case')} in ${plural(affectedTests.length, 'test file')}${
            wholeTestFiles.length === 0
              ? ''
              : `; ${plural(wholeTestFiles.length, 'whole-file fallback')}`
          }`,
    replayedTests,
    wholeTestFiles,
  }
}

function decisionKey(decision: RunPlanDecision): string {
  const file = decision.target === 'run' ? '' : decision.file
  const id = decision.target === 'test-case' ? decision.id : ''
  return `${decision.target}\0${file}\0${id}`
}

function groupReasonText(
  reason: GroupReason,
  failures: readonly CachedTestResult[],
): string[] {
  return Match.valueTags(reason, {
    File: ({ path }) => [`test file changed: ${path}`],
    Rerun: () =>
      failures.map((result) => `previous test failed: ${result.fullName}`),
    Residue: ({ path }) => [
      `observed dependency changed: ${path}`,
      `test-level dependency metadata is incomplete for change: ${path}`,
    ],
  })
}

function itemReasonText(
  reason: ItemReason,
  failure: CachedTestResult | undefined,
): string | undefined {
  return Match.valueTags(reason, {
    Dependency: ({ path }) => `observed dependency changed: ${path}`,
    Group: () => undefined,
    NeededBy: () => undefined,
    Rerun: () =>
      failure === undefined
        ? undefined
        : `previous test failed: ${failure.fullName}`,
  })
}
