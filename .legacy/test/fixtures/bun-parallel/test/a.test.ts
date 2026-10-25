import { appendFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

import { value } from '../src/a'
import { recordSpan } from '../src/span'

test('parallel bun a', async () => {
  appendFileSync('executions.log', 'bun-a\n')
  await recordSpan('bun-a', 'bun-b')
  expect(value).toBe('a')
})
