import { GRAPH_SCHEMA_VERSION } from '../../../src/core/runtime.ts'
import type {
  TiaCoverageTemplate,
  TiaRuntimeGraph,
} from '../../../src/core/runtime.ts'

export function baseGraph(
  overrides: Partial<TiaRuntimeGraph> = {},
): TiaRuntimeGraph {
  return {
    baseline: { sha: 'old', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: false,
    coverageMaps: {},
    edges: {
      'test/a.test.ts': ['src/a.ts', 'test/a.test.ts'],
      'test/b.test.ts': ['src/b.ts', 'test/b.test.ts'],
    },
    fingerprint: 'fingerprint',
    results: {
      a: { file: 'test/a.test.ts', fullName: 'a', id: 'a', state: 'passed' },
      b: { file: 'test/b.test.ts', fullName: 'b', id: 'b', state: 'passed' },
    },
    schema: GRAPH_SCHEMA_VERSION,
    testCoverage: {},
    testEdges: {
      a: { file: 'test/a.test.ts', files: ['src/a.ts', 'test/a.test.ts'] },
      b: { file: 'test/b.test.ts', files: ['src/b.ts', 'test/b.test.ts'] },
    },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

export function largeGraph(size: number): TiaRuntimeGraph {
  const graph = baseGraph({
    baseline: { sha: 'large-baseline', source: 'git', workingTree: {} },
    edges: {},
    fingerprint: 'large-fixture',
    results: {},
    testEdges: {},
  })
  for (let index = 0; index < size; index += 1) {
    const id = `case-${String(index).padStart(6, '0')}`
    const file = `test/suite-${String(index).padStart(6, '0')}.test.ts`
    const source = `src/module-${String(index).padStart(6, '0')}.ts`
    graph.edges[file] = [file, source]
    graph.results[id] = {
      file,
      fullName: `large case ${index}`,
      id,
      state: 'passed',
    }
    graph.testEdges[id] = { file, files: [file, source] }
  }
  return graph
}

export const TEMPLATE: TiaCoverageTemplate = {
  b: { 0: [0, 0] },
  branchMap: {
    0: {
      line: 1,
      loc: { end: { column: 9, line: 1 }, start: { column: 0, line: 1 } },
      locations: [],
      type: 'if',
    },
  },
  f: { 0: 0 },
  fnMap: {},
  s: { 0: 0, 1: 0 },
  statementMap: {
    0: { end: { column: 9, line: 1 }, start: { column: 0, line: 1 } },
    1: { end: { column: 9, line: 2 }, start: { column: 0, line: 2 } },
  },
}

export function coverageGraph(tests: number): TiaRuntimeGraph {
  const graph = largeGraph(tests)
  graph.coverageMaps = {
    shared: structuredClone(TEMPLATE),
    unused: structuredClone(TEMPLATE),
  }
  for (const id of Object.keys(graph.testEdges)) {
    graph.testCoverage[id] = {
      'src/shared.ts': {
        b: { 0: [1, 0] },
        f: { 0: 1 },
        map: 'shared',
        s: { 1: 2 },
      },
    }
  }
  return graph
}
