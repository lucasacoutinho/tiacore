import { appendFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import { sibling } from '../src/sibling.js'

test('runs an in-process sibling', () => {
  appendFileSync('executions.log', 'sibling\n')
  expect(sibling()).toBe('sibling')
})
