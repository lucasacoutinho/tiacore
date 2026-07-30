import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

import { value } from '../src/a'

test('parallel bun a', async () => {
  appendFileSync('executions.log', 'bun-a\n')
  const start = Date.now()
  await Bun.sleep(300)
  expect(value).toBe('a')
  mkdirSync('spans', { recursive: true })
  writeFileSync(
    'spans/bun-a.json',
    JSON.stringify({ end: Date.now(), start }),
  )
})
