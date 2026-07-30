import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { value } from '../src/missing.mjs'

test('recovers after a module import appears', () => {
  appendFileSync('executions.log', 'module-recovered\n')
  assert.equal(value, 'recovered')
})
