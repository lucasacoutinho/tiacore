import {
  byCodeUnit,
  invalidatorKey,
  observationKey,
  sortByKey,
} from '../../core/canonical.ts'
import type {
  TiaImpactGraph,
  TiaImpactPlan,
  TiaInvalidator,
} from '../../core/protocol.ts'
import type {
  TiaProtocolVerificationSnapshot,
  TiaVerificationSelection,
} from '../../core/verification.ts'
import { createImpactPlan } from '../../engine/plan/protocol.ts'
import { selectionReport } from './selection-report.ts'

/** Every suite a plan covered, run or cached. */
export function planScope(plan: TiaImpactPlan): string[] {
  return [...new Set([...plan.selected, ...plan.cached])].sort(byCodeUnit)
}

function unionBy<T>(
  key: (value: T) => string,
  ...lists: readonly (readonly T[])[]
): T[] {
  const byKey = new Map<string, T>()
  for (const list of lists) {
    for (const value of list) {
      if (!byKey.has(key(value))) byKey.set(key(value), value)
    }
  }
  return sortByKey([...byKey.values()], key)
}

/**
 * The graph the planner is asked about: the full phase's suites, and the
 * dependency evidence of both phases (the selective graph keeps what the
 * change may have removed, the full graph what it revealed).
 */
function evidenceGraph(
  selective: TiaImpactGraph,
  full: TiaImpactGraph,
): TiaImpactGraph {
  const known = new Set(full.suites.map((suite) => suite.id))
  const invalidators: TiaInvalidator[] = unionBy(
    invalidatorKey,
    selective.invalidators ?? [],
    full.invalidators ?? [],
  )
  return {
    complete: full.complete,
    environmentFingerprint: full.environmentFingerprint,
    fingerprint: full.fingerprint,
    invalidators,
    knownSources: unionBy(
      (path: string) => path,
      selective.knownSources ?? [],
      full.knownSources ?? [],
    ),
    observations: unionBy(
      observationKey,
      selective.observations.filter((item) => known.has(item.suiteId)),
      full.observations,
    ),
    protocolVersion: full.protocolVersion,
    suites: full.suites,
  }
}

/**
 * The suites the selective phase had to run. A selective phase that fell back
 * to a full plan owes every suite. Otherwise the protocol planner is asked
 * about the changed files the selective phase saw and the evidence of both
 * phases, under the strictest policy: no ignored change, and a change the
 * graph does not know requires every suite. It reads only the selective
 * plan's mode and changed files, never its own selection. A planner that
 * rejects the evidence leaves every suite owed.
 */
function expectedSuites(
  selective: TiaProtocolVerificationSnapshot,
  full: TiaProtocolVerificationSnapshot,
  scope: readonly string[],
): string[] {
  if (selective.plan.mode === 'full') return [...scope]
  try {
    const plan = createImpactPlan({
      catalog: full.graph.suites,
      changes: { files: selective.plan.changedFiles },
      currentEnvironmentFingerprint: full.graph.environmentFingerprint,
      currentFingerprint: full.graph.fingerprint,
      graph: evidenceGraph(selective.graph, full.graph),
      policy: {
        allowedSuites: [...scope],
        forceFull: false,
        ignoreChanges: [],
        onUnknownChange: 'full',
      },
    })
    return plan.selected
  } catch {
    return [...scope]
  }
}

/**
 * The selection audit of a suite-granular runner: which suites the change
 * obliged, from the evidence of both phases, against those the selective phase
 * ran. Suites outside the full phase's plan (a lane's other profiles) are not
 * owed.
 */
export function auditProtocolSelection(
  selective: TiaProtocolVerificationSnapshot,
  full: TiaProtocolVerificationSnapshot,
): TiaVerificationSelection {
  const scope = planScope(full.plan)
  const inScope = new Set(scope)
  const expected = new Set(
    expectedSuites(selective, full, scope).filter((id) => inScope.has(id)),
  )
  const executed = new Set(
    selective.executedTestIds.filter((id) => inScope.has(id)),
  )
  return selectionReport(selective.plan.changedFiles, expected, executed)
}
