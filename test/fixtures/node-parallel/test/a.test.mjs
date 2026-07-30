import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { value } from '../src/a.mjs'

test('parallel node a', async () => {
  appendFileSync('executions.log', 'node-a\n')
  const start = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(value, 'a')
  mkdirSync('spans', { recursive: true })
  writeFileSync(
    'spans/node-a.json',
    JSON.stringify({ end: Date.now(), start }),
  )
})
