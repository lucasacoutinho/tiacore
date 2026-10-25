import { existsSync, readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import ledger from './legacy-tests.json' with { type: 'json' }

const root = new URL('../../', import.meta.url)

// Every 1.x test maps to the 2.0 test file that keeps its behaviour, to a
// recorded replacement ("replaced: <why>"), or to "pending" until ported.
test('every ported 1.x test exists in its 2.0 test file', () => {
  const missing: string[] = []
  for (const [legacy, target] of Object.entries(ledger)) {
    if (target === 'pending' || target.startsWith('replaced: ')) continue
    const parts = legacy.split(' > ')
    // test.each titles are rendered from data, so check their describe block.
    const last = parts.at(-1) ?? legacy
    const title = last.startsWith("'") ? (parts.at(-2) ?? last) : last
    const file = new URL(target, root)
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(title)) {
      missing.push(`${legacy} -> ${target}`)
    }
  }
  expect(missing).toEqual([])
})
