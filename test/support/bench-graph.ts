import type {
  TiaCoverageHits,
  TiaCoverageRecord,
  TiaCoverageTemplate,
  TiaRuntimeGraph,
} from '../../src/core/runtime.ts'
import { GRAPH_SCHEMA_VERSION } from '../../src/core/runtime.ts'

// A large runtime graph for the store benchmarks: tests with edges, results and
// per-test coverage over a few hundred instrumented source files. Everything is
// computed from the indices, so two builds are equal and the graph a 1.x store
// reads is the same data as the one a 2.0 store reads.

export interface GraphShape {
  /** Branches per source file, and how many of them a test advances. */
  readonly branches: number
  readonly branchesPerTest: number
  /** Functions per source file, and how many of them a test advances. */
  readonly functions: number
  readonly functionsPerTest: number
  readonly sourceFiles: number
  /** Source files each test touches. */
  readonly sourcesPerTest: number
  /** Statements per source file, and how many of them a test advances. */
  readonly statements: number
  readonly statementsPerTest: number
  readonly testFiles: number
  readonly tests: number
}

export const LARGE_GRAPH: GraphShape = {
  branches: 12,
  branchesPerTest: 4,
  functions: 14,
  functionsPerTest: 5,
  sourceFiles: 400,
  sourcesPerTest: 6,
  statements: 80,
  statementsPerTest: 30,
  testFiles: 250,
  tests: 5000,
}

const location = (line: number) => ({
  end: { column: 40, line },
  start: { column: 2, line },
})

function template(shape: GraphShape): TiaCoverageTemplate {
  const s: Record<string, number> = {}
  const f: Record<string, number> = {}
  const b: Record<string, number[]> = {}
  const statementMap: TiaCoverageTemplate['statementMap'] = {}
  const fnMap: TiaCoverageTemplate['fnMap'] = {}
  const branchMap: TiaCoverageTemplate['branchMap'] = {}
  for (let index = 0; index < shape.statements; index += 1) {
    s[String(index)] = 0
    statementMap[String(index)] = location(index + 1)
  }
  for (let index = 0; index < shape.functions; index += 1) {
    f[String(index)] = 0
    fnMap[String(index)] = {
      decl: location(index * 5 + 1),
      line: index * 5 + 1,
      loc: location(index * 5 + 1),
      name: `fn${index}`,
    }
  }
  for (let index = 0; index < shape.branches; index += 1) {
    b[String(index)] = [0, 0]
    branchMap[String(index)] = {
      line: index * 4 + 1,
      loc: location(index * 4 + 1),
      locations: [location(index * 4 + 2), location(index * 4 + 3)],
      type: 'if',
    }
  }
  return { b, branchMap, f, fnMap, s, statementMap }
}

/** The counters test `test` advanced in source file `source`. */
function hits(
  shape: GraphShape,
  test: number,
  source: number,
  step: number,
): TiaCoverageHits {
  const s: Record<string, number> = {}
  const f: Record<string, number> = {}
  const b: Record<string, number[]> = {}
  for (let index = 0; index < shape.statementsPerTest; index += 1) {
    s[String((test + step * 3 + index) % shape.statements)] =
      1 + ((test + index) % 7)
  }
  for (let index = 0; index < shape.functionsPerTest; index += 1) {
    f[String((test + step + index) % shape.functions)] = 1 + (index % 3)
  }
  for (let index = 0; index < shape.branchesPerTest; index += 1) {
    b[String((test + step + index) % shape.branches)] = [
      1 + (index % 2),
      index % 2,
    ]
  }
  return { b, f, map: `map${source}`, s }
}

const sourceName = (source: number) => `src/module${source}.ts`
const testFileName = (file: number) => `test/file${file}.test.ts`

/** The source files test `test` touches: distinct, spread over the project. */
export function sourcesOf(shape: GraphShape, test: number): number[] {
  return Array.from(
    { length: shape.sourcesPerTest },
    (_, step) => (test * 7 + step * 53) % shape.sourceFiles,
  )
}

/** The graph a project of `shape` has after a full recorded run. */
export function runtimeGraph(shape: GraphShape): TiaRuntimeGraph {
  const coverageMaps: TiaRuntimeGraph['coverageMaps'] = {}
  for (let source = 0; source < shape.sourceFiles; source += 1) {
    coverageMaps[`map${source}`] = template(shape)
  }
  const results: TiaRuntimeGraph['results'] = {}
  const testEdges: TiaRuntimeGraph['testEdges'] = {}
  const testCoverage: TiaRuntimeGraph['testCoverage'] = {}
  const edgeSets = new Map<string, Set<string>>()
  for (let test = 0; test < shape.tests; test += 1) {
    const file = testFileName(test % shape.testFiles)
    const id = `${file}::case ${test}`
    results[id] = {
      duration: 1 + (test % 40),
      file,
      fullName: `suite ${test % 9} > case ${test}`,
      id,
      state: test % 97 === 0 ? 'failed' : 'passed',
    }
    const sources = sourcesOf(shape, test)
    const files = sources.map(sourceName)
    testEdges[id] = { file, files: [...files].sort() }
    const record: TiaCoverageRecord = {}
    sources.forEach((source, step) => {
      record[sourceName(source)] = hits(shape, test, source, step)
    })
    testCoverage[id] = record
    const edges = edgeSets.get(file) ?? new Set<string>([file])
    for (const name of files) edges.add(name)
    edgeSets.set(file, edges)
  }
  const edges: TiaRuntimeGraph['edges'] = {}
  const collectionCoverage: TiaRuntimeGraph['collectionCoverage'] = {}
  const collectionFiles: TiaRuntimeGraph['collectionFiles'] = {}
  for (let file = 0; file < shape.testFiles; file += 1) {
    const name = testFileName(file)
    edges[name] = [...(edgeSets.get(name) ?? [])].sort()
    const shared = [file * 11, file * 11 + 1].map(
      (source) => source % shape.sourceFiles,
    )
    collectionCoverage[name] = Object.fromEntries(
      shared.map((source, step) => [
        sourceName(source),
        hits(shape, file, source, step),
      ]),
    )
    collectionFiles[name] = shared.map(sourceName).sort()
  }
  return {
    baseline: {
      sha: '0123456789abcdef0123456789abcdef01234567',
      source: 'git' as const,
      workingTree: {},
    },
    collectionCoverage,
    collectionFiles,
    complete: true,
    coverageComplete: true,
    coverageMaps,
    edges,
    fingerprint: 'bench-fingerprint',
    results,
    schema: GRAPH_SCHEMA_VERSION,
    testCoverage,
    testEdges,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** The 1.x layout of the same data: schema 4 and no `collectionFiles`. */
export type LegacyRuntimeGraph = Omit<TiaRuntimeGraph, 'collectionFiles'>

export function legacyLayout(graph: TiaRuntimeGraph): LegacyRuntimeGraph {
  const { collectionFiles: _collectionFiles, ...rest } = graph
  return { ...rest, schema: 4 }
}

/**
 * The same graph after one test reran: its result, its coverage and the
 * timestamp change, everything else is the very same objects. That is what a
 * selective run's commit proposes.
 */
export function afterOneTestReran<
  G extends Pick<TiaRuntimeGraph, 'results' | 'testCoverage' | 'updatedAt'>,
>(graph: G, shape: GraphShape): G {
  const test = Math.floor(shape.tests / 2)
  const file = testFileName(test % shape.testFiles)
  const id = `${file}::case ${test}`
  const result = graph.results[id]
  const coverage = graph.testCoverage[id]
  if (result === undefined || coverage === undefined) {
    throw new Error(`the graph has no test ${id}`)
  }
  return {
    ...graph,
    results: { ...graph.results, [id]: { ...result, duration: 999 } },
    testCoverage: {
      ...graph.testCoverage,
      [id]: Object.fromEntries(
        Object.entries(coverage).map(([source, record]) => [
          source,
          { ...record, s: { ...record.s, '0': 1 } },
        ]),
      ),
    },
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
}
