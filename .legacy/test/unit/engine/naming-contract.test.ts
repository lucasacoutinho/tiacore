import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const legacyNames = [
  ['tia', 'js'].join(''),
  ['vitest', 'Tia'].join(''),
  ['vitest', '-tia'].join(''),
]

describe('tiacore naming contract', () => {
  test('keeps the source root to a single entry file', () => {
    const sourceRoot = fileURLToPath(new URL('../../../src/', import.meta.url))
    const rootFiles = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()

    expect(rootFiles).toEqual(['index.ts'])
  })

  test.each(legacyNames)('does not retain the legacy name %s', (legacyName) => {
    const result = spawnSync(
      'git',
      ['grep', '--line-number', '--ignore-case', legacyName, '--', '.'],
      {
        encoding: 'utf8',
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout || result.stderr).toBe(1)
    expect(result.stdout).toBe('')
  })
})
