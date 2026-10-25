import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const repository = fileURLToPath(new URL('../../', import.meta.url))

// Built from parts so this file does not contain the names it forbids.
const legacyNames = [
  ['tia', 'js'].join(''),
  ['vitest', 'Tia'].join(''),
  ['vitest', '-tia'].join(''),
]

// The layers of docs/architecture/effect-conventions.md, plus the entry points.
const SOURCE_DIRECTORIES = [
  'assurance',
  'cli',
  'core',
  'engine',
  'entries',
  'evidence',
  'host',
  'probe',
  'runners',
  'wire',
]

describe('tiacore naming contract', () => {
  // Every package entry point lives under src/entries and every other module
  // under one layer directory.
  test('keeps the source root to layer directories', () => {
    const entries = readdirSync(`${repository}src/`, { withFileTypes: true })

    expect(
      entries.filter((entry) => !entry.isDirectory()).map(({ name }) => name),
    ).toEqual([])
    expect(
      entries.map(({ name }) => name).sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual(SOURCE_DIRECTORIES)
  })

  test.each(legacyNames)('does not retain the legacy name %s', (legacyName) => {
    const result = spawnSync(
      'git',
      ['grep', '--line-number', '--ignore-case', legacyName, '--', '.'],
      { cwd: repository, encoding: 'utf8' },
    )

    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout || result.stderr).toBe(1)
    expect(result.stdout).toBe('')
  })
})
