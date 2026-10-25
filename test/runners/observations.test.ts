import { describe, expect, test } from 'vitest'

import type { RunPlan } from '../../src/core/runtime.ts'
import {
  fullyExecutedFiles,
  groupBy,
  moduleFailureObservation,
  observationOf,
} from '../../src/runners/shared/observations.ts'
import { baseGraph } from '../engine/support/graphs.ts'

function plan(overrides: Partial<RunPlan>): RunPlan {
  return {
    affectedTestIds: [],
    affectedTests: [],
    baseline: { origin: 'local', reason: 'r', sha: 'abc', source: 'git' },
    changedFiles: [],
    decisions: [],
    graph: null,
    mode: 'record',
    reason: 'r',
    replayedTests: 0,
    wholeTestFiles: [],
    ...overrides,
  }
}

describe('module failure observations', () => {
  // LIFE-OBS-01
  test('stand for a file that did not load', () => {
    expect(moduleFailureObservation('test/a.test.ts')).toEqual({
      file: 'test/a.test.ts',
      files: ['test/a.test.ts'],
      fullName: 'test/a.test.ts (module failure)',
      id: 'module:test/a.test.ts',
      state: 'failed',
    })
  })

  // LIFE-OBS-02
  test('a retried module failure clears even when it now yields other case ids', () => {
    const graph = baseGraph({
      results: {
        'module:test/a.test.ts': {
          file: 'test/a.test.ts',
          fullName: 'test/a.test.ts (module failure)',
          id: 'module:test/a.test.ts',
          state: 'failed',
        },
      },
    })
    const replay = plan({
      affectedTestIds: ['module:test/a.test.ts', 'plain-case'],
      graph,
      mode: 'replay',
    })
    expect(fullyExecutedFiles(replay, [], ['test/z.test.ts'])).toEqual([
      'test/a.test.ts',
      'test/z.test.ts',
    ])
    // Record mode only adds the files of module-failure observations.
    expect(
      fullyExecutedFiles(
        plan({}),
        [
          moduleFailureObservation('test/m.test.ts'),
          observationOf(
            {
              file: 'test/n.test.ts',
              fullName: 'n',
              id: 'n',
              state: 'passed',
            },
            [],
          ),
        ],
        [],
      ),
    ).toEqual(['test/m.test.ts'])
  })
})

describe('observationOf', () => {
  test('sorts and de-duplicates dependency files and copies a duration only when set', () => {
    const base = { file: 'f', fullName: 'n', id: 'i', state: 'passed' } as const
    expect(observationOf(base, ['b', 'a', 'b'])).toEqual({
      ...base,
      files: ['a', 'b'],
    })
    expect(observationOf({ ...base, duration: 3 }, [])).toHaveProperty(
      'duration',
      3,
    )
  })
})

describe('groupBy', () => {
  test('groupBy keeps first-seen key order and value order', () => {
    const groups = groupBy(['b1', 'a1', 'b2', 'a2'], (value) => value[0])
    expect([...groups]).toEqual([
      ['b', ['b1', 'b2']],
      ['a', ['a1', 'a2']],
    ])
  })
})
