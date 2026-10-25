import { appendFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import { classify } from '../src/classify.js'

test('classifies a positive number', () => {
  appendFileSync('executions.log', 'classify\n')
  expect(classify(1)).toBe('positive')
})
