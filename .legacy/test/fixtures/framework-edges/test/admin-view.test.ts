import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('renders the admin EJS view', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'view-admin\n')
  const { adminView } = await import('../src/admin-view')
  expect(await adminView()).toContain('2 admins')
})
