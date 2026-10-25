import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import {
  GENERATED_PLANS,
  generateVectors,
} from '../../config/protocol-vectors.ts'

test('the committed generated plan vectors match the TypeScript planner', () => {
  expect(readFileSync(GENERATED_PLANS, 'utf8') === generateVectors()).toBe(true)
})

test('the generated plan vectors cover every plan mode and failure family', () => {
  const { cases } = JSON.parse(generateVectors()) as {
    cases: Array<{
      expected?: { mode: string }
      expectedError?: true
      expectedReasonPrefix?: string
    }>
  }
  expect(cases.length).toBeGreaterThanOrEqual(300)
  const modes = new Set(cases.map((item) => item.expected?.mode))
  expect(modes).toEqual(new Set(['full', 'selective', 'skip', undefined]))
  expect(cases.some((item) => item.expectedError === true)).toBe(true)
  expect(cases.some((item) => item.expectedReasonPrefix !== undefined)).toBe(
    true,
  )
})
