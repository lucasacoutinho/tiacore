import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

import { value } from '../src/b'

test('parallel bun b', async () => {
  appendFileSync('executions.log', 'bun-b\n')
  const start = Date.now()
  await Bun.sleep(300)
  expect(value).toBe('b')
  mkdirSync('spans', { recursive: true })
  writeFileSync(
    'spans/bun-b.json',
    JSON.stringify({ end: Date.now(), start }),
  )
})
