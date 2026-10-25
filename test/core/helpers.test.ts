import { describe, expect, test } from 'vitest'

import { canonicalJson } from '../../src/core/canonical.ts'
import { isRecord } from '../../src/core/record.ts'
import {
  isModuleFailureId,
  moduleFailureId,
  moduleFailureResult,
} from '../../src/core/runtime.ts'

describe('isRecord', () => {
  test('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
    for (const value of [null, undefined, [], 'x', 1, true, () => 0]) {
      expect(isRecord(value)).toBe(false)
    }
  })
})

describe('canonicalJson', () => {
  test('sorts keys at every depth by code unit and keeps array order', () => {
    expect(
      canonicalJson({ b: [{ z: 1, a: 2 }, 'x'], a: null, B: { y: 1, x: 0 } }),
    ).toBe('{"B":{"x":0,"y":1},"a":null,"b":[{"a":2,"z":1},"x"]}')
  })

  test('gives equal text for equal data in any key order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalJson({ b: { d: 3, c: 2 }, a: 1 }),
    )
  })

  test('orders astral and BMP keys by UTF-16 code unit, not code point', () => {
    expect(canonicalJson({ '\u{1F600}': 1, '￿': 2 })).toBe(
      '{"\u{1F600}":1,"￿":2}',
    )
  })
})

describe('module failure identity', () => {
  test('names the failed case of a file that did not run', () => {
    expect(moduleFailureId('test/a.test.ts')).toBe('module:test/a.test.ts')
    expect(moduleFailureResult('test/a.test.ts')).toEqual({
      file: 'test/a.test.ts',
      fullName: 'test/a.test.ts (module failure)',
      id: 'module:test/a.test.ts',
      state: 'failed',
    })
  })

  test('recognizes any file by the id prefix', () => {
    expect(isModuleFailureId(moduleFailureId('x.ts'))).toBe(true)
    expect(isModuleFailureId('module:')).toBe(true)
    expect(isModuleFailureId('case-1')).toBe(false)
    expect(isModuleFailureId('a module:b')).toBe(false)
  })
})
