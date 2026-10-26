import { describe, expect, test } from 'vitest'

import { emptyGraph } from '../../src/engine/state/update.ts'
import type {
  TiaCoverageHits,
  TiaRuntimeGraph,
} from '../../src/core/runtime.ts'
import { compareVerificationSnapshots } from '../../src/assurance/verify/compare.ts'
import type {
  TiaVerificationPhase,
  TiaVerificationSnapshot,
} from '../../src/core/verification.ts'

function counters(value: {
  b?: TiaCoverageHits['b']
  f?: TiaCoverageHits['f']
  s?: TiaCoverageHits['s']
}): TiaCoverageHits {
  return {
    b: value.b ?? {},
    f: value.f ?? {},
    map: 'example',
    s: value.s ?? {},
  }
}

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
      selection: {
        changedFiles: [],
        executedTestIds: [],
        expectedTestIds: [],
        falseNegativeRate: 0,
        missedTestIds: [],
        precision: null,
        unnecessaryTestIds: [],
      },
      verified: true,
    })
  })

  test('rejects a test omitted for a changed dependency', () => {
    const selective = snapshot('selective', graph())
    selective.plan.changedFiles = ['src/example.ts']
    const result = compareVerificationSnapshots(
      selective,
      snapshot('full', graph()),
    )

    expect(result.verified).toBe(false)
    expect(result.issues).toContainEqual({
      code: 'selection-miss',
      message: 'selective phase missed 1 required test: case',
      runner: 'vitest:fixture',
    })
    expect(result.selection).toMatchObject({
      expectedTestIds: ['case'],
      falseNegativeRate: 1,
      missedTestIds: ['case'],
    })
  })

  test('uses the full graph to detect a newly lazy-loaded dependency', () => {
    const selectiveGraph = graph()
    selectiveGraph.edges['test/example.test.ts'] = ['test/example.test.ts']
    selectiveGraph.testEdges.case = {
      file: 'test/example.test.ts',
      files: ['test/example.test.ts'],
    }
    const selective = snapshot('selective', selectiveGraph)
    selective.plan.changedFiles = ['src/lazy.ts']
    const fullGraph = graph()
    fullGraph.edges['test/example.test.ts']!.push('src/lazy.ts')
    fullGraph.testEdges.case!.files.push('src/lazy.ts')

    const result = compareVerificationSnapshots(
      selective,
      snapshot('full', fullGraph),
    )

    expect(result.selection?.missedTestIds).toEqual(['case'])
    expect(result.issues.map((item) => item.code)).toContain('selection-miss')
  })

  test('requires the full suite for an unexplained changed file', () => {
    const selective = snapshot('selective', graph())
    selective.plan.changedFiles = ['src/unknown.ts']

    const result = compareVerificationSnapshots(
      selective,
      snapshot('full', graph()),
    )

    expect(result.selection?.expectedTestIds).toEqual(['case'])
    expect(result.selection?.missedTestIds).toEqual(['case'])
  })

  test('requires the full suite for structural changes', () => {
    const selective = snapshot('selective', graph())
    selective.plan.changedFiles = ['package.json']

    expect(
      compareVerificationSnapshots(selective, snapshot('full', graph()))
        .selection?.missedTestIds,
    ).toEqual(['case'])
  })

  test('does not make a deleted test file select the surviving suite', () => {
    const selective = snapshot('selective', graph())
    selective.plan.changedFiles = ['test/deleted.test.ts']

    expect(
      compareVerificationSnapshots(selective, snapshot('full', graph()))
        .selection,
    ).toMatchObject({ expectedTestIds: [], missedTestIds: [] })
  })

  test('rejects stale outcomes, dependencies, and coverage', () => {
    const selective = graph()
    selective.results.case!.state = 'passed'
    selective.testEdges.case!.files = ['test/example.test.ts']
    selective.edges['test/example.test.ts'] = ['test/example.test.ts']
    selective.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': { b: {}, f: {}, map: 'example', s: {} },
    }
    const full = graph()
    full.results.case!.state = 'failed'
    full.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': { b: {}, f: {}, map: 'example', s: { 0: 1 } },
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
      f: { 0: 1 },
      map: 'example',
      s: { 0: 1 },
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

  test('names the test file, source file, and counter kind on coverage mismatch', () => {
    const selective = graph()
    const full = graph()
    selective.collectionCoverage['test/a.test.ts'] = {
      'src/a.ts': counters({ b: { 0: [0, 1] }, s: { 0: 4 } }),
      'src/gone.ts': counters({ f: { 0: 1 } }),
    }
    full.collectionCoverage['test/a.test.ts'] = {
      'src/a.ts': counters({ b: { 0: [1, 1] }, s: { 0: 9 } }),
    }
    selective.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': counters({ s: { 0: 1 } }),
      'src/other.ts': counters({ f: { 1: 2 } }),
    }
    full.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': counters({ s: { 0: 0 } }),
      'src/other.ts': counters({ b: { 0: [1, 0] }, f: { 1: 0 } }),
    }
    selective.collectionCoverage['test/stable.test.ts'] = {
      'src/stable.ts': counters({ f: { 0: 2 }, s: { 0: 4 } }),
    }
    full.collectionCoverage['test/stable.test.ts'] = {
      'src/stable.ts': counters({ f: { 0: 8 }, s: { 0: 9 } }),
    }
    full.collectionCoverage['test/only-full.test.ts'] = {
      'src/only.ts': counters({ s: { 3: 1 } }),
    }

    const result = compareVerificationSnapshots(
      snapshot('selective', selective),
      snapshot('full', full),
    )

    expect(result.verified).toBe(false)
    expect(result.issues).toEqual([
      {
        code: 'coverage-mismatch',
        differences: [
          {
            kind: 'branch',
            sourceFile: 'src/a.ts',
            testFile: 'test/a.test.ts',
          },
          {
            kind: 'function',
            sourceFile: 'src/gone.ts',
            testFile: 'test/a.test.ts',
          },
          {
            kind: 'statement',
            sourceFile: 'src/example.ts',
            testFile: 'test/example.test.ts',
          },
          {
            kind: 'branch',
            sourceFile: 'src/other.ts',
            testFile: 'test/example.test.ts',
          },
          {
            kind: 'function',
            sourceFile: 'src/other.ts',
            testFile: 'test/example.test.ts',
          },
          {
            kind: 'statement',
            sourceFile: 'src/only.ts',
            testFile: 'test/only-full.test.ts',
          },
        ],
        message:
          'selective and full phases produced different reconstructed coverage evidence',
        runner: 'vitest:fixture',
      },
    ])
  })

  test('keeps the first 8 coverage differences in code-unit order', () => {
    const selective = graph()
    const full = graph()
    for (let index = 0; index < 6; index += 1) {
      const testFile = `test/file-${index}.test.ts`
      selective.collectionCoverage[testFile] = {
        'src/a.ts': counters({
          b: { 0: [1, 0] },
          f: { 0: 1 },
          s: { 0: 1 },
        }),
      }
      full.collectionCoverage[testFile] = {
        'src/a.ts': counters({}),
      }
    }

    const result = compareVerificationSnapshots(
      snapshot('selective', selective),
      snapshot('full', full),
    )

    expect(result.issues).toEqual([
      {
        code: 'coverage-mismatch',
        differences: [
          {
            kind: 'branch',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-0.test.ts',
          },
          {
            kind: 'function',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-0.test.ts',
          },
          {
            kind: 'statement',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-0.test.ts',
          },
          {
            kind: 'branch',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-1.test.ts',
          },
          {
            kind: 'function',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-1.test.ts',
          },
          {
            kind: 'statement',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-1.test.ts',
          },
          {
            kind: 'branch',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-2.test.ts',
          },
          {
            kind: 'function',
            sourceFile: 'src/a.ts',
            testFile: 'test/file-2.test.ts',
          },
        ],
        message:
          'selective and full phases produced different reconstructed coverage evidence',
        runner: 'vitest:fixture',
      },
    ])
  })

  test('reports a coverage-map id change with an empty difference list', () => {
    const selective = graph()
    const full = graph()
    selective.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': { ...counters({ s: { 0: 1 } }), map: 'left' },
    }
    full.collectionCoverage['test/example.test.ts'] = {
      'src/example.ts': { ...counters({ s: { 0: 1 } }), map: 'right' },
    }

    const result = compareVerificationSnapshots(
      snapshot('selective', selective),
      snapshot('full', full),
    )

    expect(result.issues).toEqual([
      {
        code: 'coverage-mismatch',
        differences: [],
        message:
          'selective and full phases produced different reconstructed coverage evidence',
        runner: 'vitest:fixture',
      },
    ])
  })

  test('reports a coverage-completeness disagreement with an empty difference list', () => {
    const selective = graph()
    selective.coverageComplete = false

    const result = compareVerificationSnapshots(
      snapshot('selective', selective),
      snapshot('full', graph()),
    )

    expect(result.issues).toEqual([
      {
        code: 'coverage-mismatch',
        differences: [],
        message:
          'selective and full phases produced different reconstructed coverage evidence',
        runner: 'vitest:fixture',
      },
    ])
  })
})
