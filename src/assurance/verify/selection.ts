import {
  isModuleFailureId,
  type CachedTestResult,
  type RunPlanBaseline,
  type RuntimePlanOptions,
  type TiaRuntimeGraph,
  type TiaTestEdge,
} from '../../core/runtime.ts'
import type {
  TiaVerificationSelection,
  TiaVerificationSnapshot,
} from '../../core/verification.ts'
import { planRuntimeChanges } from '../../engine/plan/runtime.ts'
import { selectionReport } from './selection-report.ts'

const BASELINE: RunPlanBaseline = {
  origin: 'none',
  reason: 'verification',
  sha: null,
  source: null,
}

// Verification cannot prove that an unknown change is safe to ignore, so it
// plans with the strictest options.
const STRICT: RuntimePlanOptions = {
  fresh: false,
  ignoreChanges: [],
  onUnknownChange: 'full',
}

function isRunnable(result: CachedTestResult): boolean {
  return result.state !== 'skipped' && !isModuleFailureId(result.id)
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])]
}

/**
 * The graph the planner is asked about: the full run's results (the tests that
 * exist now), the dependency evidence of both runs (the selective graph keeps
 * removed dependencies, the full graph reveals new ones) and the selective
 * run's failures, which have to run again.
 */
function evidenceGraph(
  selective: TiaRuntimeGraph,
  full: TiaRuntimeGraph,
): TiaRuntimeGraph {
  const edges: Record<string, string[]> = {}
  for (const graph of [selective, full]) {
    for (const [file, sources] of Object.entries(graph.edges)) {
      edges[file] = union(edges[file] ?? [], sources)
    }
  }
  const testEdges: Record<string, TiaTestEdge> = {}
  for (const graph of [selective, full]) {
    for (const [id, edge] of Object.entries(graph.testEdges)) {
      const known = testEdges[id]
      testEdges[id] =
        known === undefined
          ? { file: edge.file, files: [...edge.files] }
          : { file: edge.file, files: union(known.files, edge.files) }
    }
  }
  const results: Record<string, CachedTestResult> = {}
  for (const [id, result] of Object.entries(full.results)) {
    const failed =
      isRunnable(result) && selective.results[id]?.state === 'failed'
    results[id] = {
      file: result.file,
      fullName: result.fullName,
      id: result.id,
      state: failed
        ? 'failed'
        : result.state === 'failed'
          ? 'passed'
          : result.state,
    }
  }
  return { ...full, edges, results, testEdges }
}

/**
 * Derives the tests a selective phase had to execute by asking the runtime
 * planner (the same Lean-modelled `select` the real planner uses) about the
 * evidence of both graphs. It reads only the selective plan's mode, changed
 * files and whole-file fallbacks, never its own decisions.
 */
export function auditVerificationSelection(
  selective: TiaVerificationSnapshot,
  full: TiaVerificationSnapshot,
): TiaVerificationSelection {
  const runnable = Object.values(full.graph.results).filter(isRunnable)
  const universe = new Set(runnable.map((result) => result.id))
  const files = new Set(
    Object.values(full.graph.results).map((result) => result.file),
  )
  const expected = new Set<string>()
  const addFile = (file: string) => {
    for (const result of runnable) {
      if (result.file === file) expected.add(result.id)
    }
  }

  const plan = planRuntimeChanges(
    {
      baseline: BASELINE,
      fingerprint: full.graph.fingerprint,
      graph: evidenceGraph(selective.graph, full.graph),
      options: STRICT,
    },
    selective.plan.changedFiles,
    (file) => files.has(file),
  )
  if (selective.plan.mode === 'record' || plan.mode === 'record') {
    for (const id of universe) expected.add(id)
  } else {
    for (const id of plan.affectedTestIds) {
      if (universe.has(id)) expected.add(id)
    }
    for (const file of plan.wholeTestFiles) addFile(file)
    for (const file of selective.plan.wholeTestFiles) addFile(file)
  }

  const executed = new Set(
    selective.executedTestIds.filter((id) => universe.has(id)),
  )
  return selectionReport(selective.plan.changedFiles, expected, executed)
}
