import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

describe('account suite', () => {
  test('nested case', async () => {
    appendFileSync('executions.log', 'node-nested\n')
    const { a } = await import('../src/a.mjs')
    assert.equal(a(), 'a')
  })
})
