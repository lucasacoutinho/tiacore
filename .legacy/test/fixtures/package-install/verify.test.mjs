import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('the second installed-package run is served from the TIA graph', async () => {
  const executions = (await readFile('executions.log', 'utf8'))
    .trim()
    .split('\n')

  assert.deepEqual(executions, ['executed'])
})
