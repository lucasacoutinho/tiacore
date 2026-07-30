import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('shard case a', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a\n')
  const { a } = await import('../src/a')
  expect(a()).toBe('a')
})
