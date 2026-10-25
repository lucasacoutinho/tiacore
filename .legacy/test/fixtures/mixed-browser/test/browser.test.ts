import { expect, test } from 'vitest'
import { commands } from 'vitest/browser'

test('browser affected b case', async () => {
  await commands.markExecution('browser-b')
  const { b } = await import('../src/b.js')
  expect(b()).toBe('b')
})

test('browser cached a sibling', async () => {
  await commands.markExecution('browser-a-sibling')
  const { a } = await import('../src/a.js')
  expect(a()).toBe('a')
})
