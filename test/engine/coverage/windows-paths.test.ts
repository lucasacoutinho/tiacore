import { createInstrumenter } from 'istanbul-lib-instrument'
import { describe, expect, test } from 'vitest'

import {
  CoverageTemplates,
  instrumentationHash,
} from '../../../src/engine/coverage/templates.ts'
import { legacy } from '../../support/legacy.ts'

// The Istanbul half of 1.x test/unit/protocol/paths.test.ts. Its other tests
// cover host path handling and live in test/engine/host-path.test.ts.

const old = await legacy<{
  CoverageTemplates: typeof CoverageTemplates
  instrumentationHash: typeof instrumentationHash
}>('integrations/coverage/templates.js')

function record(root: string, path: string) {
  const instrumenter = createInstrumenter({ esModules: true })
  const code = instrumenter.instrumentSync('export const a = 1\n', path)
  const templates = new CoverageTemplates()
  templates.register(code, instrumenter.lastFileCoverage())
  const hash = instrumentationHash(code) ?? ''
  return templates.record(root, {
    [path]: { b: {}, f: {}, hash, s: { 0: 1 } },
  })
}

describe('portable path handling', () => {
  test('stores Windows Istanbul coverage as project-relative slash paths', () => {
    const instrumenter = createInstrumenter({ esModules: true })
    const code = instrumenter.instrumentSync(
      'export const a = 1\n',
      'C:\\work\\repo\\src\\a.ts',
    )
    const templates = new CoverageTemplates()
    templates.register(code, instrumenter.lastFileCoverage())
    const hash = instrumentationHash(code) ?? ''
    const result = templates.record('C:\\work\\repo', {
      'C:\\work\\repo\\src\\a.ts': { b: {}, f: {}, hash, s: { 0: 1 } },
    })

    expect(Object.keys(result)).toEqual(['src/a.ts'])
  })

  test('matches 1.x for drive-letter, UNC and mixed-separator paths', () => {
    const cases: Array<[root: string, path: string]> = [
      ['C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts'],
      ['C:\\work\\repo', 'c:/work/repo/src\\nested/b.ts'],
      ['C:\\work\\repo', 'D:\\work\\repo\\src\\a.ts'],
      ['C:\\work\\repo', 'C:\\work\\repository\\src\\a.ts'],
      ['\\\\server\\share\\repo', '\\\\server\\share\\repo\\src\\a.ts'],
      ['\\\\server\\share\\repo', '\\\\server\\other\\repo\\src\\a.ts'],
      ['/work/repo', '/work/repo/src/a.ts'],
      ['/work/repo', '/work/other/a.ts'],
    ]
    for (const [root, path] of cases) {
      const instrumenter = createInstrumenter({ esModules: true })
      const code = instrumenter.instrumentSync('export const a = 1\n', path)
      const coverage = instrumenter.lastFileCoverage()
      const hash = old.instrumentationHash(code) ?? ''
      const counters = { [path]: { b: {}, f: {}, hash, s: { 0: 1 } } }

      const before = new old.CoverageTemplates()
      before.register(code, coverage)
      const after = new CoverageTemplates()
      after.register(code, coverage)

      expect(after.record(root, counters)).toEqual(
        before.record(root, counters),
      )
      expect(after.unknownFiles(root, counters)).toEqual(
        before.unknownFiles(root, counters),
      )
    }
  })

  test('drops Windows files outside the root and the root itself', () => {
    expect(record('C:\\work\\repo', 'D:\\work\\repo\\src\\a.ts')).toEqual({})
    expect(record('C:\\work\\repo', 'C:\\work\\repository\\a.ts')).toEqual({})
    expect(record('C:\\work\\repo', 'C:\\work\\repo')).toEqual({})
  })
})
