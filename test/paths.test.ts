import { describe, expect, test } from 'vitest'

import { portableCoverageMap } from '../src/coverage/report.js'
import {
  isInside,
  projectRelative,
  resolveCacheDir,
  slash,
} from '../src/shared/paths.js'

describe('portable path handling', () => {
  test('normalizes drive-letter and mixed-separator paths', () => {
    expect(
      projectRelative(
        'C:\\work\\tiacore',
        'c:/work/tiacore/src\\feature.ts',
      ),
    ).toBe('src/feature.ts')
    expect(
      projectRelative('C:\\work\\tiacore', 'D:\\work\\tiacore\\src\\a.ts'),
    ).toBeNull()
    expect(projectRelative('C:\\work\\tiacore', 'C:\\work\\tiacore')).toBe('')
    expect(slash('test\\feature.test.ts')).toBe('test/feature.test.ts')
  })

  test('handles UNC roots and rejects sibling-prefix escapes', () => {
    expect(
      projectRelative(
        '\\\\server\\share\\repo',
        '\\\\server\\share\\repo\\src\\a.ts',
      ),
    ).toBe('src/a.ts')
    expect(
      projectRelative(
        '\\\\server\\share\\repo',
        '\\\\server\\other\\repo\\src\\a.ts',
      ),
    ).toBeNull()
    expect(
      isInside('C:\\work\\repo', 'C:\\work\\repository\\a.ts'),
    ).toBe(false)
    expect(
      isInside('C:\\work\\repo', 'c:/work/repo/src/a.ts'),
    ).toBe(true)
  })

  test('resolves Windows cache directories without host-OS leakage', () => {
    expect(resolveCacheDir('C:\\work\\repo', '.tia')).toBe(
      'C:\\work\\repo\\.tia',
    )
    expect(
      resolveCacheDir('C:\\work\\repo', 'D:/cache/tiacore'),
    ).toBe('D:\\cache\\tiacore')
    expect(resolveCacheDir('/work/repo', '.tia')).toBe('/work/repo/.tia')
  })

  test('stores Windows Istanbul coverage as project-relative slash paths', () => {
    const portable = portableCoverageMap('C:\\work\\repo', {
      'C:\\work\\repo\\src\\a.ts': {
        b: {},
        branchMap: {},
        f: {},
        fnMap: {},
        path: 'C:\\work\\repo\\src\\a.ts',
        s: {},
        statementMap: {},
      },
    })

    expect(Object.keys(portable)).toEqual(['src/a.ts'])
    expect(portable['src/a.ts']?.path).toBe('src/a.ts')
  })

  test('preserves POSIX containment behavior', () => {
    expect(projectRelative('/work/repo', '/work/repo/src/a.ts')).toBe(
      'src/a.ts',
    )
    expect(projectRelative('/work/repo', '/work/other/a.ts')).toBeNull()
    expect(isInside('/work/repo', '/work/repo')).toBe(true)
  })
})
