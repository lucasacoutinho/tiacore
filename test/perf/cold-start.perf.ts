import { afterAll, beforeAll, expect, test } from 'vitest'

import {
  cold,
  createColdTemplate,
  current,
  old,
  removeColdTemplate,
} from '../support/cold-start.ts'
import { median } from '../support/stats.ts'

const ROUNDS = 7

/**
 * Budget against 1.x for each paired run: a phase may take twice as long as in
 * 1.x plus a little for timer noise. Effect's first use costs more than 1.x's
 * synchronous calls (measured 1.2x to 1.6x for prepare and 1.0x to 1.4x for
 * commit on a git project of 40 test files); the budget catches a stage that
 * regresses far beyond that.
 */
const BUDGET = { commit: 2, prepare: 2, slackMs: 10 }

beforeAll(createColdTemplate)
afterAll(removeColdTemplate)

test('cold prepare and commit stay within the budget of 1.x', () => {
  // Each round runs both versions back to back, alternating which goes first,
  // so a load spike hits both sides of one pair. A pair passes when 2.0 is
  // within the budget of that round's 1.x; the median pair decides.
  const margin = { commit: [] as number[], prepare: [] as number[] }
  for (let round = 0; round < ROUNDS; round += 1) {
    const pair =
      round % 2 === 0
        ? { current: cold(current), legacy: cold(old) }
        : { legacy: cold(old), current: cold(current) }
    for (const phase of ['commit', 'prepare'] as const) {
      margin[phase].push(
        pair.current[phase] -
          (pair.legacy[phase] * BUDGET[phase] + BUDGET.slackMs),
      )
    }
  }
  for (const phase of ['prepare', 'commit'] as const) {
    expect(
      median(margin[phase]),
      `${phase} margins against the budget: ${margin[phase].map(Math.round).join(', ')} ms`,
    ).toBeLessThan(0)
  }
}, 120_000)
