import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { value } from '../src/b.mjs'

test('parallel node b', async () => {
  appendFileSync('executions.log', 'node-b\n')
  const start = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(value, 'b')
  mkdirSync('spans', { recursive: true })
  writeFileSync(
    'spans/node-b.json',
    JSON.stringify({ end: Date.now(), start }),
  )
})
