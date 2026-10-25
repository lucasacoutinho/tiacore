import { emptyGraph } from '../../src/engine/state/update.ts'
import type {
  TiaImpactGraph,
  TiaImpactPlan,
  TiaImpactPlanMode,
} from '../../src/core/protocol.ts'
import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import type {
  TiaProtocolVerificationSnapshot,
  TiaVerificationPhase,
  TiaVerificationSnapshot,
} from '../../src/core/verification.ts'

/** A complete one-test graph: test/example.test.ts depends on src/example.ts. */
export function exampleGraph(): TiaRuntimeGraph {
  const value = emptyGraph()
  value.complete = true
  value.coverageComplete = true
  value.fingerprint = 'fixture'
  value.results.case = {
    file: 'test/example.test.ts',
    fullName: 'example case',
    id: 'case',
    state: 'passed',
  }
  value.edges['test/example.test.ts'] = [
    'src/example.ts',
    'test/example.test.ts',
  ]
  value.testEdges.case = {
    file: 'test/example.test.ts',
    files: ['src/example.ts', 'test/example.test.ts'],
  }
  return value
}

export function exampleSnapshot(
  phase: TiaVerificationPhase,
  graph: TiaRuntimeGraph = exampleGraph(),
  runner = 'vitest:fixture',
): TiaVerificationSnapshot {
  return {
    executedTestIds: phase === 'full' ? ['case'] : [],
    generatedAt: '2026-07-31T00:00:00.000Z',
    graph,
    phase,
    plan: {
      affectedTestIds: [],
      affectedTests: [],
      baseline: {
        origin: 'local',
        reason: 'fixture',
        sha: 'abc',
        source: 'git',
      },
      changedFiles: [],
      decisions: [],
      mode: phase === 'full' ? 'record' : 'replay',
      reason: 'fixture',
      replayedTests: phase === 'full' ? 0 : 1,
      wholeTestFiles: [],
    },
    runner,
    schema: 1,
    success: true,
  }
}

/**
 * A complete two-suite protocol graph: suite `a` depends on its own file and
 * on shared/util.js, suite `b` only on its own file.
 */
export function protocolGraph(): TiaImpactGraph {
  return {
    complete: true,
    environmentFingerprint: 'env',
    fingerprint: 'fixture',
    invalidators: [{ pattern: 'package.json', reason: 'package.json changed' }],
    knownSources: [],
    observations: [
      {
        confidence: 'exact',
        kind: 'configuration',
        source: 'k6/a.js',
        suiteId: 'k6:p:k6/a.js',
      },
      {
        confidence: 'exact',
        kind: 'import',
        source: 'shared/util.js',
        suiteId: 'k6:p:k6/a.js',
      },
      {
        confidence: 'exact',
        kind: 'configuration',
        source: 'k6/b.js',
        suiteId: 'k6:p:k6/b.js',
      },
    ],
    protocolVersion: 1,
    suites: [
      { adapter: 'k6', file: 'k6/a.js', id: 'k6:p:k6/a.js', project: 'p' },
      { adapter: 'k6', file: 'k6/b.js', id: 'k6:p:k6/b.js', project: 'p' },
    ],
  }
}

export const SUITE_A = 'k6:p:k6/a.js'
export const SUITE_B = 'k6:p:k6/b.js'

/** A protocol plan that ran `selected` and left the rest of `scope` cached. */
export function protocolPlan(
  mode: TiaImpactPlanMode,
  selected: string[],
  changedFiles: string[] = [],
  scope: string[] = [SUITE_A, SUITE_B],
): TiaImpactPlan {
  return {
    cached: scope.filter((id) => !selected.includes(id)),
    changedFiles,
    mode,
    protocolVersion: 1,
    reason: mode === 'full' ? 'policy requires a full run' : 'fixture',
    reasons: Object.fromEntries(selected.map((id) => [id, ['fixture']])),
    resourceLocks: [],
    selected,
  }
}

/**
 * A suite-granular snapshot. The full phase runs both suites, and the
 * selective phase runs suite a only, for a change to shared/util.js.
 */
export function protocolSnapshot(
  phase: TiaVerificationPhase,
  overrides: Partial<TiaProtocolVerificationSnapshot> = {},
  runner = 'k6:.tia/k6/graph.json',
): TiaProtocolVerificationSnapshot {
  const full = phase === 'full'
  const executed = full ? [SUITE_A, SUITE_B] : [SUITE_A]
  return {
    executedTestIds: executed,
    generatedAt: '2026-07-31T00:00:00.000Z',
    graph: protocolGraph(),
    kind: 'protocol',
    phase,
    plan: full
      ? protocolPlan('full', executed)
      : protocolPlan('selective', executed, ['shared/util.js']),
    runner,
    schema: 1,
    success: true,
    suiteOutcomes: Object.fromEntries(executed.map((id) => [id, 'passed'])),
    ...overrides,
  }
}
