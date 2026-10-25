import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('renders the user EJS view', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'view-user\n')
  const { userView } = await import('../src/user-view')
  expect(await userView()).toContain('Hello Lucas')
})
