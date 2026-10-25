import { emptyGraph } from '../../src/engine/state/update.ts'
import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import type {
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
