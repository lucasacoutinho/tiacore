import { describe, expect, test } from 'vitest'

import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from '../../../src/core/defaults.ts'
import { globMatcher } from '../../../src/engine/glob.ts'
import { instrumentationName } from '../../../src/runners/vitest/plugin.ts'

const include = globMatcher(DEFAULT_INCLUDE)
const exclude = globMatcher(DEFAULT_EXCLUDE)
const root = '/repo/packages/a'
const repositoryRoot = '/repo'

describe('instrumentationName', () => {
  test('names a sibling source and drops hoisted dependencies', () => {
    expect(
      instrumentationName(
        root,
        repositoryRoot,
        '/repo/packages/b/src/value.ts',
        include,
        exclude,
      ),
    ).toBe('../b/src/value.ts')
    expect(
      instrumentationName(
        root,
        repositoryRoot,
        '/repo/node_modules/zod/index.js',
        include,
        exclude,
      ),
    ).toBeNull()
    expect(
      instrumentationName(
        root,
        repositoryRoot,
        '/repo/packages/b/node_modules/zod/index.js',
        include,
        exclude,
      ),
    ).toBeNull()
  })
})
