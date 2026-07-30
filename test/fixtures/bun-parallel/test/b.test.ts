import { appendFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

import { value } from '../src/b'
import { recordSpan } from '../src/span'

test('parallel bun b', async () => {
  appendFileSync('executions.log', 'bun-b\n')
  await recordSpan('bun-b', 'bun-a')
  expect(value).toBe('b')
})
