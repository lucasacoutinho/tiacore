import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

test('node case a', async () => {
  appendFileSync('executions.log', 'node-a\n')
  const { a } = await import('../src/a.mjs')
  assert.equal(a(), 'a')
})

test('node case b', async () => {
  appendFileSync('executions.log', 'node-b\n')
  const { b } = await import('../src/b.mjs')
  assert.equal(b(), 'b')
})

test.skip('node skipped case', () => {
  appendFileSync('executions.log', 'node-skipped-body\n')
})
