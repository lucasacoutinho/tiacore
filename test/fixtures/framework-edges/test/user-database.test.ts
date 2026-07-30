import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('queries the users table', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'database-user\n')
  const { userName } = await import('../src/user-database')
  expect(userName()).toBe('Lucas')
})
