import { describe, expect, test } from 'vitest'

import {
  isInside,
  projectFile,
  projectRelative,
  resolveCacheDir,
  slash,
  trackedFile,
} from '../../src/engine/host-path.ts'
import { legacy } from '../support/legacy.ts'

// Host path handling, compared with 1.x. The Istanbul path cases are in
// test/engine/coverage/windows-paths.test.ts.

const oracle = await legacy<{
  isInside: typeof isInside
  projectRelative: typeof projectRelative
  resolveCacheDir: typeof resolveCacheDir
  slash: typeof slash
}>('shared/paths.js')

describe('portable path handling', () => {
  test('names a repository file outside the project root', () => {
    const root = '/repo/packages/a'
    const boundary = '/repo'
    expect(trackedFile(root, '/repo/packages/b/src/value.ts', boundary)).toBe(
      '../b/src/value.ts',
    )
    expect(trackedFile(root, '/repo/packages/a/src/use.ts', boundary)).toBe(
      'src/use.ts',
    )
    expect(trackedFile(root, '/repo/packages/b/src/value.ts')).toBeNull()
    expect(trackedFile(root, '/other/value.ts', boundary)).toBeNull()
    expect(trackedFile(root, root, boundary)).toBeNull()
    expect(trackedFile(root, boundary, boundary)).toBeNull()
    expect(
      trackedFile('/repo/packages/nested/a', boundary, boundary),
    ).toBeNull()
  })

  test('normalizes drive-letter and mixed-separator paths', () => {
    expect(
      projectRelative('C:\\work\\tiacore', 'c:/work/tiacore/src\\feature.ts'),
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
    expect(isInside('C:\\work\\repo', 'C:\\work\\repository\\a.ts')).toBe(false)
    expect(isInside('C:\\work\\repo', 'c:/work/repo/src/a.ts')).toBe(true)
  })

  test('resolves Windows cache directories without host-OS leakage', () => {
    expect(resolveCacheDir('C:\\work\\repo', '.tia')).toBe(
      'C:\\work\\repo\\.tia',
    )
    expect(resolveCacheDir('C:\\work\\repo', 'D:/cache/tiacore')).toBe(
      'D:\\cache\\tiacore',
    )
    expect(resolveCacheDir('/work/repo', '.tia')).toBe('/work/repo/.tia')
  })

  test('names a file below the root, never the root or an outside path', () => {
    expect(projectFile('C:\\work\\tiacore', 'c:/work/tiacore/src/a.ts')).toBe(
      'src/a.ts',
    )
    expect(projectFile('C:\\work\\tiacore', 'C:\\work\\tiacore')).toBeNull()
    expect(projectFile('C:\\work\\tiacore', 'D:\\work\\a.ts')).toBeNull()
    expect(projectFile('/work/repo', '/work/repo/src/a.ts')).toBe('src/a.ts')
    expect(projectFile('/work/repo', '/work/repo')).toBeNull()
    expect(projectFile('/work/repo', '/work/repo/../other/a.ts')).toBeNull()
  })

  test('preserves POSIX containment behavior', () => {
    expect(projectRelative('/work/repo', '/work/repo/src/a.ts')).toBe(
      'src/a.ts',
    )
    expect(projectRelative('/work/repo', '/work/other/a.ts')).toBeNull()
    expect(isInside('/work/repo', '/work/repo')).toBe(true)
  })

  test('agrees with 1.x on a grid of roots and paths', () => {
    const roots = [
      '/work/repo',
      'C:\\work\\repo',
      'c:/work/repo',
      '\\\\srv\\share\\repo',
      '//srv/share/repo',
      'relative/root',
    ]
    const paths = [
      '/work/repo',
      '/work/repo/a.ts',
      '/work/repository/a.ts',
      '/work/repo/../x',
      'C:\\work\\repo\\src\\a.ts',
      'c:/work/repo/../repository',
      'D:\\work\\repo',
      '\\\\srv\\share\\repo\\a',
      '\\\\srv\\other\\repo\\a',
      'src/a.ts',
      '..',
      '',
    ]
    for (const root of roots) {
      for (const path of paths) {
        expect(projectRelative(root, path), `${root} | ${path}`).toBe(
          oracle.projectRelative(root, path),
        )
        expect(isInside(root, path), `${root} | ${path}`).toBe(
          oracle.isInside(root, path),
        )
        expect(resolveCacheDir(root, path), `${root} | ${path}`).toBe(
          oracle.resolveCacheDir(root, path),
        )
      }
    }
    expect(slash('a\\b/c\\')).toBe(oracle.slash('a\\b/c\\'))
  })
})
