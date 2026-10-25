import { appendFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

test('bun case a', async () => {
  appendFileSync('executions.log', 'bun-a\n')
  const { a } = await import('../src/a')
  expect(a()).toBe('a')
})

test('bun case b', async () => {
  appendFileSync('executions.log', 'bun-b\n')
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
})
