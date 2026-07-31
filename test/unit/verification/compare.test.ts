import { describe, expect, test } from 'vitest'

import { emptyGraph } from '../../../src/engine/state/update.js'
import type { TiaRuntimeGraph } from '../../../src/engine/types.js'
import { compareVerificationSnapshots } from '../../../src/verification/compare.js'
import type {
  TiaVerificationPhase,
  TiaVerificationSnapshot,
} from '../../../src/verification/types.js'

function graph(): TiaRuntimeGraph {
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

function snapshot(
  phase: TiaVerificationPhase,
  value: TiaRuntimeGraph,
): TiaVerificationSnapshot {
  return {
    executedTestIds: phase === 'full' ? ['case'] : [],
    generatedAt: '2026-07-31T00:00:00.000Z',
    graph: value,
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
    runner: 'vitest:fixture',
    schema: 1,
    success: true,
  }
}

describe('differential verification', () => {
  test('accepts equivalent selective and full evidence', () => {
    const value = graph()
    const result = compareVerificationSnapshots(
      snapshot('selective', structuredClone(value)),
      snapshot('full', structuredClone(value)),
    )

    expect(result).toEqual({
      issues: [],
      runner: 'vitest:fixture',
      verified: true,
    })
  })

  test('rejects stale outcomes, dependencies, and coverage', () => {
    const selective = graph()
    selective.results.case!.state = 'passed'
    selective.testEdges.case!.files = ['test/example.test.ts']
    selective.edges['test/example.test.ts'] = ['test/example.test.ts']
    selective.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': {
        b: {},
        branchMap: {},
        f: {},
        fnMap: {},
        path: 'src/example.ts',
        s: { 0: 0 },
        statementMap: {
          0: {
            end: { column: 1, line: 1 },
            start: { column: 0, line: 1 },
          },
        },
      },
    }
    const full = graph()
    full.results.case!.state = 'failed'
    full.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': {
        b: {},
        branchMap: {},
        f: {},
        fnMap: {},
        path: 'src/example.ts',
        s: { 0: 1 },
        statementMap: {
          0: {
            end: { column: 1, line: 1 },
            start: { column: 0, line: 1 },
          },
        },
      },
    }

    const result = compareVerificationSnapshots(
      snapshot('selective', selective),
      snapshot('full', full),
    )

    expect(result.verified).toBe(false)
    expect(result.issues.map((item) => item.code).sort()).toEqual([
      'coverage-mismatch',
      'dependency-mismatch',
      'outcome-mismatch',
    ])
  })

  test('compares coverage topology instead of unstable hit counts', () => {
    const selective = graph()
    const full = graph()
    const coverage = {
      b: { 0: [1, 0] },
      branchMap: {},
      f: { 0: 1 },
      fnMap: {},
      path: 'src/example.ts',
      s: { 0: 1 },
      statementMap: {},
    }
    selective.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': coverage,
    }
    full.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': {
        ...coverage,
        b: { 0: [91, 0] },
        f: { 0: 17 },
        s: { 0: 43 },
      },
    }
    selective.testCoverage.case = {
      'src/example.ts': coverage,
    }
    full.testCoverage.case = {
      'src/example.ts': {
        ...coverage,
        b: { 0: [0, 1] },
      },
    }

    expect(
      compareVerificationSnapshots(
        snapshot('selective', selective),
        snapshot('full', full),
      ),
    ).toMatchObject({ issues: [], verified: true })
  })
})
