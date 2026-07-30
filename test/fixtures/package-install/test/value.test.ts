import { appendFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import { value } from '../src/value.js'

test('runs tiajs from an installed package', () => {
  appendFileSync('executions.log', 'executed\n')
  expect(value()).toBe('installed')
})
