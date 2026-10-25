import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import { writeCoverageReports } from '../../src/engine/coverage/report.ts'
import type { TiaCoverageRuntime } from '../../src/engine/coverage/types.ts'
import {
  coverageMapId,
  coverageTemplate,
} from '../../src/engine/state/coverage.ts'
import { assertNoLeak } from '../support/leak.ts'

// A run with coverage enabled rebuilds Istanbul coverage from the
// graph and writes the reports on every complete run.

let root = ''

const location = (line: number) => ({
  end: { column: 10, line },
  start: { column: 0, line },
})

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tiacore-coverage-leak-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'src/a.js'),
    'export const a = 1\nexport const b = 2\n',
  )
})

afterAll(() => {
  rmSync(root, { force: true, recursive: true })
})

function graph(): TiaRuntimeGraph {
  const template = coverageTemplate({
    b: { 0: [0, 0] },
    branchMap: {
      0: {
        line: 1,
        loc: location(1),
        locations: [location(1), location(2)],
        type: 'if',
      },
    },
    f: { 0: 0 },
    fnMap: {
      0: { decl: location(1), line: 1, loc: location(1), name: 'a' },
    },
    s: { 0: 0, 1: 0 },
    statementMap: { 0: location(1), 1: location(2) },
  })
  const map = coverageMapId(template)
  return {
    baseline: { sha: '', workingTree: {} },
    collectionCoverage: {},
    collectionFiles: {},
    complete: true,
    coverageComplete: true,
    coverageMaps: { [map]: template },
    edges: {},
    fingerprint: 'fp',
    results: {},
    schema: 5,
    testCoverage: {
      t: {
        'src/a.js': { b: { 0: [1, 0] }, f: { 0: 1 }, map, s: { 0: 1, 1: 0 } },
      },
    },
    testEdges: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const runtime = (): TiaCoverageRuntime => ({
  clean: true,
  cleanOnRerun: true,
  enabled: true,
  exclude: [],
  include: null,
  reportOnFailure: false,
  reporters: [
    { name: 'json', options: {} },
    { name: 'lcovonly', options: {} },
    { name: 'text-summary', options: { file: 'summary.txt' } },
  ],
  reportsDirectory: join(root, 'coverage'),
  skipFull: false,
  thresholds: null,
  watermarks: {
    branches: [50, 80],
    functions: [50, 80],
    lines: [50, 80],
    statements: [50, 80],
  },
})

describe('coverage reports', () => {
  test('writing them again and again retains nothing and opens nothing', async () => {
    const value = graph()
    const options = runtime()
    const result = await assertNoLeak(
      async () => {
        const report = await Effect.runPromise(
          writeCoverageReports(value, root, options),
        )
        expect(report.files).toBe(1)
      },
      { batches: 3, bytesPerOperation: 32_768, iterations: 25 },
    )
    expect(result.bytesPerOperation).toBeLessThan(32_768)
    expect(readdirSync(join(root, 'coverage')).sort()).toEqual([
      'coverage-final.json',
      'lcov.info',
      'summary.txt',
    ])
  }, 120_000)
})
