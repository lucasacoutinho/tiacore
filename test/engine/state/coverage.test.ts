import type { FileCoverageData } from 'istanbul-lib-coverage'
import { describe, expect, test } from 'vitest'

import type {
  TiaCoverageHits,
  TiaCoverageTemplate,
  TiaRuntimeGraph,
} from '../../../src/core/runtime.ts'
import {
  cloneGraph,
  compactFileCoverage,
  coverageMapId,
  coverageTemplate,
  expandCoverageHits,
  pruneCoverageMaps,
  referencedCoverageMaps,
} from '../../../src/engine/state/coverage.ts'
import { legacy } from '../../support/legacy.ts'
import { baseGraph, coverageGraph } from '../support/graphs.ts'

// STATE-COV-01..06: graph-side coverage. The 1.x tests that reach these
// functions through integrations/coverage (CoverageTemplates) belong to the
// integrations port; here every function is compared with 1.x directly.

const oracle = await legacy<{
  compactFileCoverage: typeof compactFileCoverage
  coverageMapId: typeof coverageMapId
  coverageTemplate: typeof coverageTemplate
  expandCoverageHits: typeof expandCoverageHits
}>('engine/state/coverage.js')

const location = (line: number) => ({
  end: { column: 10, line },
  start: { column: 0, line },
})

function fileCoverage(hits: [number, number]): FileCoverageData {
  return {
    b: { 0: hits, 1: [0, 0, 3] },
    branchMap: {
      0: {
        line: 1,
        loc: location(1),
        locations: [location(1), location(2)],
        type: 'if',
      },
      1: { line: 3, loc: location(3), locations: [], type: 'switch' },
    },
    f: { 0: hits[0], 1: 0 },
    fnMap: {
      0: { decl: location(1), line: 1, loc: location(1), name: 'example' },
    },
    path: '/project/src/a.ts',
    s: { 0: hits[0], 1: hits[1], 2: 0 },
    statementMap: { 0: location(1), 1: location(2), 2: location(3) },
  }
}

describe('coverage templates', () => {
  test('zero every counter and keep canonical key order, sharing the maps', () => {
    const file = fileCoverage([2, 0])
    const template = coverageTemplate(file)
    expect(Object.keys(template)).toEqual([
      'b',
      'branchMap',
      'f',
      'fnMap',
      's',
      'statementMap',
    ])
    expect(template.s).toEqual({ 0: 0, 1: 0, 2: 0 })
    expect(template.f).toEqual({ 0: 0, 1: 0 })
    expect(template.b).toEqual({ 0: [0, 0], 1: [0, 0, 0] })
    expect(template.statementMap).toBe(file.statementMap)
    expect(template.branchMap).toBe(file.branchMap)
    expect(template).toEqual(oracle.coverageTemplate(file))
  })

  test('are named by content, not by path (STATE-COV-02)', () => {
    const local = coverageTemplate(fileCoverage([1, 0]))
    const ci = coverageTemplate(fileCoverage([5, 5]))
    expect(coverageMapId(local)).toBe(coverageMapId(ci))
    expect(coverageMapId(local)).toMatch(/^[a-f0-9]{64}$/u)
    expect(coverageMapId(local)).toBe(oracle.coverageMapId(local))
    const other = coverageTemplate({ ...fileCoverage([1, 0]), s: { 0: 0 } })
    expect(coverageMapId(other)).not.toBe(coverageMapId(local))
  })

  test('compact into advanced counters and expand to the exact dense data (STATE-COV-03, -04)', () => {
    const file = fileCoverage([3, 0])
    const { hits, template } = compactFileCoverage(file)
    expect(hits).toEqual({
      b: { 0: [3, 0], 1: [0, 0, 3] },
      f: { 0: 3 },
      s: { 0: 3 },
    })
    expect(hits).toEqual(oracle.compactFileCoverage(file).hits)
    const dense = expandCoverageHits(template, 'src/a.ts', hits)
    expect(dense).toEqual({ ...file, path: 'src/a.ts' })
    expect(dense).toEqual(oracle.expandCoverageHits(template, 'src/a.ts', hits))
    expect(dense.statementMap).toBe(template.statementMap)
    const untouched = compactFileCoverage(fileCoverage([0, 0]))
    expect(untouched.hits.b).toEqual({ 1: [0, 0, 3] })
  })

  test('expansion never mutates the template or the hits', () => {
    const template = coverageTemplate(fileCoverage([0, 0]))
    const frozen = structuredClone(template)
    const hits: Omit<TiaCoverageHits, 'map'> = {
      b: { 0: [1, 1] },
      f: { 0: 1 },
      s: { 1: 4 },
    }
    const dense = expandCoverageHits(template, 'x.ts', hits)
    dense.b[1]![0] = 99
    dense.s[0] = 99
    expect(template).toEqual(frozen)
    expect(hits.s).toEqual({ 1: 4 })
  })
})

describe('coverage map bookkeeping', () => {
  test('lists referenced maps and prunes the rest in place (STATE-COV-05)', () => {
    const graph = coverageGraph(4)
    graph.collectionCoverage['test/a.test.ts'] = {
      'src/b.ts': { b: {}, f: {}, map: 'collection', s: {} },
    }
    graph.coverageMaps.collection = graph.coverageMaps
      .shared as TiaCoverageTemplate
    expect([...referencedCoverageMaps(graph)].sort()).toEqual([
      'collection',
      'shared',
    ])
    const table = graph.coverageMaps
    pruneCoverageMaps(graph)
    expect(Object.keys(graph.coverageMaps).sort()).toEqual([
      'collection',
      'shared',
    ])
    expect(graph.coverageMaps).toBe(table)
  })

  test('cloning deep-copies the records and shares the immutable maps (STATE-COV-06)', () => {
    const graph = coverageGraph(4)
    const copy = cloneGraph(graph)
    expect(copy).toEqual(graph)
    expect(copy.coverageMaps).not.toBe(graph.coverageMaps)
    expect(copy.coverageMaps.shared).toBe(graph.coverageMaps.shared)
    expect(copy.testCoverage).not.toBe(graph.testCoverage)
    expect(copy.testCoverage['case-000000']).not.toBe(
      graph.testCoverage['case-000000'],
    )
    delete copy.coverageMaps.shared
    copy.results['case-000000']!.state = 'failed'
    expect(graph.coverageMaps.shared).toBeDefined()
    expect(graph.results['case-000000']!.state).toBe('passed')
  })

  test('an empty graph references nothing', () => {
    const graph: TiaRuntimeGraph = baseGraph()
    expect(referencedCoverageMaps(graph).size).toBe(0)
  })
})
