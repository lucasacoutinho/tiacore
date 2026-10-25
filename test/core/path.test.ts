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

// Two 1.x defects are excluded from the comparison:
// - it kept trailing slashes, so `x/../` became `./` and passed its root check;
//   2.0 rejects that path as naming the root;
// - it stripped a leading `./` before normalizing, so `.//src` became `/src`
//   and was rejected as absolute; 2.0 accepts it as `src`.
const strippedToAbsolute = /^(?:\.[/\\])+[/\\]/u

function legacyAccepted(value: string): string | undefined {
  if (strippedToAbsolute.test(value)) return accepted(value)
  let path
  try {
    path = normalizeProtocolPath(value)
  } catch {
    return undefined
  }
  const trimmed = path.replace(/\/$/u, '')
  return trimmed === '.' ? undefined : trimmed
}

const segments = ['', '.', '..', 'src', 'c:', '...']
const separators = ['/', '\\']

function* allPaths(prefix: string, depth: number): Generator<string> {
  yield prefix
  if (depth === 0) return
  for (const name of segments) {
    for (const slash of separators)
      yield* allPaths(`${prefix}${name}${slash}`, depth - 1)
  }
}

describe('normalizePath', () => {
  it('agrees with 1.x on every path of up to three segments', () => {
    const disagreements = [...allPaths('', 3)].filter(
      (value) => accepted(value) !== legacyAccepted(value),
    )
    expect(disagreements).toEqual([])
  })

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
