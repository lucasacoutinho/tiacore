import { describe, expect, test } from 'vitest'

import { mergeTestWindows } from '../../src/probe/index.ts'
import type { ProbeTestWindow } from '../../src/probe/index.ts'

describe('mergeTestWindows', () => {
  test('keeps every file any attempt touched and sums shared counters', () => {
    const failed: ProbeTestWindow = {
      coverage: {
        'src/first.ts': { b: {}, f: { 0: 1 }, hash: 'h1', s: { 0: 1 } },
        'src/shared.ts': {
          b: { 0: [1, 0] },
          f: { 0: 1 },
          hash: 'h2',
          s: { 0: 2, 1: 1 },
        },
      },
      files: ['src/first.ts', 'src/shared.ts'],
    }
    const passed: ProbeTestWindow = {
      coverage: {
        'src/second.ts': { b: {}, f: {}, hash: 'h3', s: { 0: 1 } },
        'src/shared.ts': {
          b: { 0: [0, 3], 1: [1] },
          f: { 1: 1 },
          hash: 'h2',
          s: { 0: 1, 2: 4 },
        },
      },
      files: ['src/second.ts', 'src/shared.ts'],
    }
    expect(mergeTestWindows(failed, passed)).toEqual({
      coverage: {
        'src/first.ts': { b: {}, f: { 0: 1 }, hash: 'h1', s: { 0: 1 } },
        'src/second.ts': { b: {}, f: {}, hash: 'h3', s: { 0: 1 } },
        'src/shared.ts': {
          b: { 0: [1, 3], 1: [1] },
          f: { 0: 1, 1: 1 },
          hash: 'h2',
          s: { 0: 3, 1: 1, 2: 4 },
        },
      },
      files: ['src/first.ts', 'src/second.ts', 'src/shared.ts'],
    })
  })

  test('leaves both inputs unchanged', () => {
    const first: ProbeTestWindow = {
      coverage: { 'a.ts': { b: { 0: [1] }, f: {}, hash: 'h', s: { 0: 1 } } },
      files: ['a.ts'],
    }
    const second: ProbeTestWindow = {
      coverage: { 'a.ts': { b: { 0: [2] }, f: {}, hash: 'h', s: { 0: 2 } } },
      files: ['a.ts'],
    }
    const snapshot = JSON.stringify([first, second])
    mergeTestWindows(first, second)
    expect(JSON.stringify([first, second])).toBe(snapshot)
  })

  test('takes the later counters when the instrumentation changed', () => {
    const later = { b: {}, f: {}, hash: 'new', s: { 0: 1 } }
    expect(
      mergeTestWindows(
        {
          coverage: { 'a.ts': { b: {}, f: {}, hash: 'old', s: { 0: 5 } } },
          files: ['a.ts'],
        },
        { coverage: { 'a.ts': later }, files: ['a.ts'] },
      ).coverage['a.ts'],
    ).toEqual(later)
  })
})
