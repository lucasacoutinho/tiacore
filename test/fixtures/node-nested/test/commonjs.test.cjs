const { appendFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const test = require('node:test')

test('CommonJS case', () => {
  appendFileSync('executions.log', 'node-commonjs\n')
  const { c } = require('../src/c.cjs')
  assert.equal(c(), 'c')
})
