import { appendFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import { covered } from '../src/covered.js'

test('covers one branch', () => {
  appendFileSync('executions.log', 'covered\n')
  expect(covered(true)).toBe('yes')
  if (process.env.TIA_FIXTURE_FAIL === '1') {
    expect('actual').toBe('expected')
  }
})
