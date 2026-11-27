import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, test } from 'vitest'

import {
  hasNativeSelection,
  loadVitestCliParser,
  nativeSelectionLabels,
} from '../../../src/runners/vitest/options.ts'

beforeAll(loadVitestCliParser)

const roots: string[] = []

/** A project that already holds the outputs of an earlier run. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-vitest-options-'))
  roots.push(root)
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'test', 'a.test.ts'), '')
  writeFileSync(join(root, 'report.json'), '{}')
  mkdirSync(join(root, 'coverage'))
  mkdirSync(join(root, '.vitest-reports'))
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

const argv = (...args: string[]) => ['node', '/bin/vitest.mjs', ...args]
const script = (...args: string[]) => [
  'node',
  '/project/scripts/ci.mjs',
  ...args,
]

describe('command-line file filters', () => {
  test.each([
    ['--outputFile', 'report.json'],
    ['--outputFile.json', 'report.json'],
    ['--coverage.reportsDirectory', 'coverage'],
    ['--merge-reports', '.vitest-reports'],
    ['--reporter', 'verbose', '--outputFile', 'report.json'],
    ['--config', 'test/a.test.ts'],
  ])('a flag value is not a filter: %s %s', (...args) => {
    const root = project()
    expect(hasNativeSelection(root, {}, argv('run', ...args))).toBe(false)
    expect(nativeSelectionLabels(root, {}, argv('run', ...args))).toEqual([])
  })

  test.each([
    ['test/a.test.ts'],
    ['--coverage', 'test/a.test.ts'],
    ['--reporter', 'verbose', 'test'],
    ['test/a.test.ts:3'],
  ])('a positional test path is a filter: %s', (...args) => {
    const root = project()
    expect(hasNativeSelection(root, {}, argv('run', ...args))).toBe(true)
    expect(nativeSelectionLabels(root, {}, argv('run', ...args))).toEqual([
      'file filters',
    ])
  })

  test('a substring filter on the Vitest command line is a filter', () => {
    const root = project()
    expect(hasNativeSelection(root, {}, argv('run', 'a.te'))).toBe(true)
    expect(nativeSelectionLabels(root, {}, argv('a.te'))).toEqual([
      'file filters',
    ])
  })

  test('another program counts only arguments that name test paths', () => {
    const root = project()
    expect(hasNativeSelection(root, {}, script('unit'))).toBe(false)
    expect(hasNativeSelection(root, {}, script('test/a.test.ts'))).toBe(true)
  })

  test('the related command names sources, not test filters', () => {
    const root = project()
    expect(
      nativeSelectionLabels(root, {}, argv('related', 'test/a.test.ts')),
    ).toEqual([])
  })
})
