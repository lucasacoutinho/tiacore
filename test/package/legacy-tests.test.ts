import { existsSync, readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import ledger from './legacy-tests.json' with { type: 'json' }

const root = new URL('../../', import.meta.url)

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** True when `source` names `title` literally or as a `%s` or `${…}` title template. */
function containsTitle(source: string, title: string): boolean {
  if (source.includes(title)) return true
  const templates = [
    ...[...source.matchAll(/'([^'\n]*%[sdi][^'\n]*)'/gu)].map(([, text]) =>
      escape(text ?? '').replace(/%[sdi]/gu, '.+'),
    ),
    ...[...source.matchAll(/`([^`\n]*\$\{[^`\n]*)`/gu)].map(([, text]) =>
      (text ?? '')
        .split(/\$\{[^}]*\}/u)
        .map(escape)
        .join('.+'),
    ),
  ]
  return templates.some((pattern) =>
    new RegExp(`^${pattern}$`, 'u').test(title),
  )
}

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
    if (
      !existsSync(file) ||
      !containsTitle(readFileSync(file, 'utf8'), title)
    ) {
      missing.push(`${legacy} -> ${target}`)
    }
  }
  expect(missing).toEqual([])
})
