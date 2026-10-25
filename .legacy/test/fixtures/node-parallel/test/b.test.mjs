import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { value } from '../src/b.mjs'
import { recordSpan } from '../src/span.mjs'

test('parallel node b', async () => {
  appendFileSync('executions.log', 'node-b\n')
  await recordSpan('node-b', 'node-a')
  assert.equal(value, 'b')
})
