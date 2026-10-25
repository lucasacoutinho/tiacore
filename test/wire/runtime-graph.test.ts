import { describe, expect, test } from 'vitest'

import {
  GRAPH_SCHEMA_VERSION,
  type TiaRuntimeGraph,
} from '../../src/core/runtime.ts'
import { parseRuntimeGraph } from '../../src/wire/runtime-graph.ts'

function graph(overrides: Partial<TiaRuntimeGraph> = {}): TiaRuntimeGraph {
  return {
    baseline: { sha: 'abc', source: 'git', workingTree: { 'src/a.ts': 'h1' } },
    collectionCoverage: {
      'test/a.test.ts': {
        'src/a.ts': { b: {}, f: {}, map: 'm1', s: { 0: 1 } },
      },
    },
    complete: true,
    coverageComplete: true,
    coverageMaps: {
      m1: {
        b: {},
        branchMap: {},
        f: {},
        fnMap: {},
        s: { 0: 0 },
        statementMap: {},
      },
    },
    edges: { 'test/a.test.ts': ['src/a.ts'] },
    fingerprint: 'fp',
    results: {
      'test/a.test.ts#a': {
        duration: 3,
        file: 'test/a.test.ts',
        fullName: 'a',
        id: 'test/a.test.ts#a',
        state: 'passed',
      },
    },
    schema: GRAPH_SCHEMA_VERSION,
    testCoverage: {},
    testEdges: {
      'test/a.test.ts#a': { file: 'test/a.test.ts', files: ['src/a.ts'] },
    },
    updatedAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  }
}

describe('parseRuntimeGraph', () => {
  test('returns a current graph without copying it', () => {
    const value = graph()
    expect(parseRuntimeGraph(value)).toBe(value)
  })

  test('treats a 1.x schema-4 graph as a cache miss', () => {
    expect(parseRuntimeGraph({ ...graph(), schema: 4 })).toBeNull()
  })

  test('rejects coverage that names a missing static map', () => {
    expect(
      parseRuntimeGraph(
        graph({
          testCoverage: {
            'test/a.test.ts#a': {
              'src/a.ts': { b: {}, f: {}, map: 'gone', s: {} },
            },
          },
        }),
      ),
    ).toBeNull()
  })

  test.each([
    [
      'unsafe counter',
      {
        coverageMaps: {
          m1: {
            b: {},
            branchMap: {},
            f: {},
            fnMap: {},
            s: { 0: 2 ** 60 },
            statementMap: {},
          },
        },
      },
    ],
    [
      'unknown result state',
      { results: { x: { file: 'f', fullName: 'x', id: 'x', state: 'flaky' } } },
    ],
    ['inverted partition', { partition: { index: 3, total: 2 } }],
    ['missing baseline', { baseline: undefined }],
  ])('rejects a graph with an %s', (_, overrides) => {
    expect(parseRuntimeGraph({ ...graph(), ...overrides })).toBeNull()
  })

  test('rejects values that are not graphs', () => {
    for (const value of [null, 'graph', [], 42])
      expect(parseRuntimeGraph(value)).toBeNull()
  })
})
