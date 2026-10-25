import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('reporter case b', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'b\n')
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
})
