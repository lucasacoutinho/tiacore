import { appendFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('queries the orders table', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'database-order\n')
  const { orderTotal } = await import('../src/order-database')
  expect(orderTotal()).toBe(42)
})
