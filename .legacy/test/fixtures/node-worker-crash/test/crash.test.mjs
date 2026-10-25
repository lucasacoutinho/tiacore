import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

import { value } from '../src/value.mjs'

test('worker crash case', () => {
  appendFileSync('executions.log', 'worker\n')
  if (process.env.TIACORE_INJECT_WORKER_CRASH === '1') {
    process.kill(process.ppid, 'SIGKILL')
    process.exit(0)
  }
  assert.equal(value(), 'stable')
})
