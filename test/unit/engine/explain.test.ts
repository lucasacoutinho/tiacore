import { describe, expect, test } from 'vitest'

import {
  formatRunPlanDetails,
  type RunPlan,
} from '../../../src/entries/core.js'

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    affectedTestIds: [],
    affectedTests: [],
    baseline: {
      artifactId: 'artifact-42',
      origin: 'artifact',
      provider: 'fixture registry',
      reason: 'compatible artifact restored',
      sha: 'abcdef1234567890',
      source: 'git',
    },
    changedFiles: [],
    decisions: [],
    graph: null,
    mode: 'replay',
    reason: 'no affected test files',
    replayedTests: 2,
    wholeTestFiles: [],
    ...overrides,
  }
}

describe('runtime plan explanations', () => {
  test('formats baseline provenance and caps selected targets', () => {
    expect(
      formatRunPlanDetails(
        plan({
          decisions: [
            {
              file: 'test/a.test.ts',
              id: 'a',
              reasons: ['observed dependency changed: src/a.ts'],
              target: 'test-case',
            },
            {
              file: 'test/b.test.ts',
              reasons: ['test file changed: test/b.test.ts'],
              target: 'test-file',
            },
          ],
        }),
        1,
      ),
    ).toEqual([
      'TIA baseline: artifact git graph at abcdef123456 from fixture registry (compatible artifact restored).',
      'TIA selected test/a.test.ts#a: observed dependency changed: src/a.ts.',
      'TIA selection: 1 additional decision omitted.',
    ])
  })

  test('reports the absence of a reusable graph', () => {
    expect(
      formatRunPlanDetails(
        plan({
          baseline: {
            origin: 'none',
            reason: 'no local graph found',
            sha: null,
            source: null,
          },
          mode: 'record',
        }),
      ),
    ).toEqual(['TIA baseline: none (no local graph found).'])
  })
})
