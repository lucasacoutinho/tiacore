import { spawnSync } from 'node:child_process'

import { describe, expect, test } from 'vitest'

const legacyNames = [
  ['tia', 'js'].join(''),
  ['vitest', 'Tia'].join(''),
  ['vitest', '-tia'].join(''),
]

describe('tiacore naming contract', () => {
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
