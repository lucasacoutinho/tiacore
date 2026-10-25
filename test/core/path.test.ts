import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'

import { normalizePath } from '../../src/core/path.ts'
import { legacy } from '../support/legacy.ts'

const { normalizeProtocolPath } = await legacy<{
  normalizeProtocolPath: (value: string) => string
}>('protocol/paths.js')

const segment = Arbitrary.schema(
  Schema.Literals(['', '.', '..', 'src', 'a.ts', 'c:', 'x', '...']),
)
const separator = Arbitrary.schema(Schema.Literals(['/', '\\']))
const rawPath = Arbitrary.array(Arbitrary.all([segment, separator]), {
  maxLength: 6,
}).pipe(
  Arbitrary.map((parts) =>
    parts.map(([name, slash]) => `${name}${slash}`).join(''),
  ),
)

function accepted(value: string): string | undefined {
  const result = normalizePath(value)
  return result._tag === 'Accepted' ? result.path : undefined
}

// 1.x keeps trailing slashes, so `x/../` became `./` and passed its root check.
// 2.0 drops trailing slashes and rejects that path as naming the root.
function legacyAccepted(value: string): string | undefined {
  let path
  try {
    path = normalizeProtocolPath(value)
  } catch {
    return undefined
  }
  const trimmed = path.replace(/\/$/u, '')
  return trimmed === '.' ? undefined : trimmed
}

describe('normalizePath', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['./src//./a.ts', 'src/a.ts'],
    ['src\\lib\\b.ts', 'src/lib/b.ts'],
    ['src/../lib/b.ts', 'lib/b.ts'],
    ['src/', 'src'],
    ['...', '...'],
  ])('accepts %s as %s', (value, expected) => {
    expect(normalizePath(value)).toEqual({ _tag: 'Accepted', path: expected })
  })

  it.each([
    ['', 'empty'],
    ['.', 'empty'],
    ['src/..', 'empty'],
    ['..', 'escape'],
    ['src/../..', 'escape'],
    ['/etc/passwd', 'absolute'],
    ['\\\\server\\share', 'absolute'],
    ['c:/repo/a.ts', 'uri'],
    ['https://example.test/a.ts', 'uri'],
    ['a\0b', 'nul'],
    ['a'.repeat(4097), 'too-long'],
  ])('rejects %j as %s', (value, reason) => {
    expect(normalizePath(value)).toEqual({ _tag: 'Rejected', reason })
  })

  it.prop(
    'is idempotent and keeps only real segments',
    [rawPath],
    ([value]) => {
      const path = accepted(value)
      if (path === undefined) return
      expect(accepted(path)).toBe(path)
      for (const part of path.split('/')) {
        expect(['', '.', '..']).not.toContain(part)
      }
    },
  )

  it.prop(
    'agrees with 1.x except for trailing slashes',
    [rawPath],
    ([value]) => {
      expect(accepted(value)).toBe(legacyAccepted(value))
    },
  )
})
