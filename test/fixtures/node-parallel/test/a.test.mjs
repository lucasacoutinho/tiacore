import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { value } from '../src/a.mjs'
import { recordSpan } from '../src/span.mjs'

test('parallel node a', async () => {
  appendFileSync('executions.log', 'node-a\n')
  await recordSpan('node-a', 'node-b')
  assert.equal(value, 'a')
})
