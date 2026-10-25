import { appendFileSync } from 'node:fs'

import { expect, test } from 'vitest'

test('node a project', async () => {
  appendFileSync('executions.log', 'node-a\n')
  const { a } = await import('../src/a.js')
  expect(a()).toBe('a')
})
