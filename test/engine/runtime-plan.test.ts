import { describe, expect, test } from 'vitest'

import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import {
  gateRuntimePlan,
  planRuntimeChanges,
  type RuntimePlanInput,
} from '../../src/engine/plan/runtime.ts'

function graph(overrides: Partial<TiaRuntimeGraph> = {}): TiaRuntimeGraph {
  return {
    baseline: { sha: 'abc', source: 'git', workingTree: {} },
    collectionCoverage: {},
    collectionFiles: {},
    complete: true,
    coverageComplete: true,
    coverageMaps: {},
    edges: {
      'test/a.test.ts': [
        'src/a.ts',
        'test/__tests__/helper.ts',
        'test/a.test.ts',
      ],
      'test/b.test.ts': ['src/b.ts', 'test/b.test.ts'],
    },
    fingerprint: 'fp',
    results: {
      a: { file: 'test/a.test.ts', fullName: 'a', id: 'a', state: 'passed' },
      b: { file: 'test/b.test.ts', fullName: 'b', id: 'b', state: 'passed' },
    },
    schema: 5,
    testCoverage: {},
    testEdges: {
      a: {
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/__tests__/helper.ts'],
      },
      b: { file: 'test/b.test.ts', files: ['src/b.ts'] },
    },
    updatedAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

function input(overrides: Partial<RuntimePlanInput> = {}): RuntimePlanInput {
  return {
    baseline: {
      origin: 'local',
      reason: 'local graph loaded',
      sha: 'abc',
      source: 'git',
    },
    fingerprint: 'fp',
    graph: graph(),
    options: { fresh: false, ignoreChanges: [], onUnknownChange: 'full' },
    ...overrides,
  }
}

const everyFile = () => true

describe('runtime planning', () => {
  test('selects the dependents of a changed helper under __tests__', () => {
    // The test-file pattern does not stop the walk: the helper's dependents
    // are still selected.
    const plan = planRuntimeChanges(
      input(),
      ['test/__tests__/helper.ts'],
      everyFile,
    )
    expect(plan.affectedTestIds).toEqual(['a'])
    expect(plan.decisions).toEqual([
      {
        file: 'test/a.test.ts',
        id: 'a',
        reasons: ['observed dependency changed: test/__tests__/helper.ts'],
        target: 'test-case',
      },
      {
        file: 'test/__tests__/helper.ts',
        reasons: ['test file changed: test/__tests__/helper.ts'],
        target: 'test-file',
      },
    ])
  })

  test.each([
    [
      {
        options: {
          fresh: true,
          ignoreChanges: [],
          onUnknownChange: 'full' as const,
        },
      },
      'fresh graph requested',
    ],
    [{ graph: null }, 'no compatible graph found'],
    [{ graph: graph({ complete: false }) }, 'the previous graph is incomplete'],
    [
      { coverageRequested: true, graph: graph({ coverageComplete: false }) },
      'the cached coverage graph is incomplete',
    ],
    [{ fingerprint: 'other' }, 'project structure changed'],
  ])('runs everything when a gate trips (%#)', (overrides, reason) => {
    expect(gateRuntimePlan(input(overrides))).toMatchObject({
      mode: 'record',
      reason,
    })
  })

  test('admits a compatible graph for selection', () => {
    expect(gateRuntimePlan(input())).toBeNull()
  })

  test('neither selects nor replays test files that no longer exist', () => {
    const plan = planRuntimeChanges(
      input(),
      ['src/b.ts'],
      (file) => file !== 'test/b.test.ts',
    )
    expect(plan).toMatchObject({
      affectedTestIds: [],
      replayedTests: 1,
      wholeTestFiles: [],
    })
    expect(Object.keys(plan.graph?.results ?? {})).toEqual(['a'])
  })
})
