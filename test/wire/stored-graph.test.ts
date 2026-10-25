import { describe, expect, test } from 'vitest'

import { isStoredGraph } from '../../src/wire/stored-graph.ts'
import { matchesRuntimeGraphSchema } from '../../src/wire/runtime-graph.ts'
import { coverageGraph } from '../engine/support/graphs.ts'

// The store validates with a hand-written guard because the Schema guard is
// five times slower on a 2,000-test graph. This test pins the two together:
// every mutation below must be accepted or rejected by both alike.

type Mutable = Record<string, any>

function base(): Mutable {
  const graph = coverageGraph(3)
  graph.collectionCoverage['test/a.test.ts'] = {
    'src/shared.ts': { b: {}, f: {}, map: 'shared', s: { 0: 1 } },
  }
  graph.results['case-000000']!.duration = 12.5
  graph.partition = { group: 'g', index: 1, total: 2 }
  return graph as unknown as Mutable
}

const mutations: Array<[string, (graph: Mutable) => void]> = [
  ['valid', () => {}],
  ['schema 4', (g) => (g.schema = 4)],
  ['schema string', (g) => (g.schema = '5')],
  ['schema missing', (g) => delete g.schema],
  ['complete string', (g) => (g.complete = 'yes')],
  ['coverageComplete missing', (g) => delete g.coverageComplete],
  ['fingerprint number', (g) => (g.fingerprint = 1)],
  ['updatedAt missing', (g) => delete g.updatedAt],
  ['baseline missing', (g) => delete g.baseline],
  ['baseline array', (g) => (g.baseline = [])],
  ['baseline.sha number', (g) => (g.baseline.sha = 1)],
  ['source svn', (g) => (g.baseline.source = 'svn')],
  ['source git', (g) => (g.baseline.source = 'git')],
  ['source filesystem', (g) => (g.baseline.source = 'filesystem')],
  ['source undefined', (g) => (g.baseline.source = undefined)],
  ['workingTree number', (g) => (g.baseline.workingTree = { a: 1 })],
  ['workingTree array', (g) => (g.baseline.workingTree = [])],
  ['workingTree ok', (g) => (g.baseline.workingTree = { a: 'h' })],
  ['partition ok', (g) => (g.partition = { index: 2, total: 2 })],
  ['partition index 0', (g) => (g.partition = { index: 0, total: 2 })],
  ['partition index > total', (g) => (g.partition = { index: 3, total: 2 })],
  ['partition fractional', (g) => (g.partition = { index: 1.5, total: 2 })],
  [
    'partition group number',
    (g) => (g.partition = { group: 1, index: 1, total: 1 }),
  ],
  ['partition null', (g) => (g.partition = null)],
  ['partition undefined', (g) => (g.partition = undefined)],
  ['partition missing', (g) => delete g.partition],
  ['edges missing', (g) => delete g.edges],
  ['edges number list', (g) => (g.edges.x = [1])],
  ['edges string', (g) => (g.edges.x = 'a')],
  ['results missing', (g) => delete g.results],
  ['result state weird', (g) => (g.results['case-000000'].state = 'weird')],
  ['result state skipped', (g) => (g.results['case-000000'].state = 'skipped')],
  ['result duration NaN', (g) => (g.results['case-000000'].duration = NaN)],
  [
    'result duration Infinity',
    (g) => (g.results['case-000000'].duration = Infinity),
  ],
  ['result duration string', (g) => (g.results['case-000000'].duration = '1')],
  ['result duration null', (g) => (g.results['case-000000'].duration = null)],
  [
    'result duration undefined',
    (g) => (g.results['case-000000'].duration = undefined),
  ],
  ['result duration absent', (g) => delete g.results['case-000000'].duration],
  ['result id missing', (g) => delete g.results['case-000000'].id],
  ['result null', (g) => (g.results['case-000000'] = null)],
  ['testEdges missing', (g) => delete g.testEdges],
  ['testEdge files number', (g) => (g.testEdges['case-000000'].files = [1])],
  ['testEdge file missing', (g) => delete g.testEdges['case-000000'].file],
  ['coverageMaps missing', (g) => delete g.coverageMaps],
  ['map unreferenced removed', (g) => delete g.coverageMaps.unused],
  ['map referenced removed', (g) => delete g.coverageMaps.shared],
  ['template s float', (g) => (g.coverageMaps.shared.s = { 0: 0.5 })],
  ['template s unsafe', (g) => (g.coverageMaps.shared.s = { 0: 2 ** 60 })],
  ['template s negative', (g) => (g.coverageMaps.shared.s = { 0: -3 })],
  [
    'template s min safe',
    (g) => (g.coverageMaps.shared.s = { 0: Number.MIN_SAFE_INTEGER }),
  ],
  ['template b flat', (g) => (g.coverageMaps.shared.b = { 0: 1 })],
  ['template b strings', (g) => (g.coverageMaps.shared.b = { 0: ['a'] })],
  ['template branchMap array', (g) => (g.coverageMaps.shared.branchMap = [])],
  ['template branchMap null', (g) => (g.coverageMaps.shared.branchMap = null)],
  [
    'template statementMap missing',
    (g) => delete g.coverageMaps.shared.statementMap,
  ],
  ['template fnMap string', (g) => (g.coverageMaps.shared.fnMap = 'x')],
  ['template f missing', (g) => delete g.coverageMaps.shared.f],
  [
    'hits map number',
    (g) => (g.testCoverage['case-000000']['src/shared.ts'].map = 1),
  ],
  [
    'hits map missing',
    (g) => delete g.testCoverage['case-000000']['src/shared.ts'].map,
  ],
  [
    'hits s float',
    (g) => (g.testCoverage['case-000000']['src/shared.ts'].s = { 1: 1.5 }),
  ],
  [
    'hits b mixed',
    (g) => (g.testCoverage['case-000000']['src/shared.ts'].b = { 0: [1, 'x'] }),
  ],
  [
    'hits f missing',
    (g) => delete g.testCoverage['case-000000']['src/shared.ts'].f,
  ],
  ['hits record array', (g) => (g.testCoverage['case-000000'] = [])],
  [
    'hits unknown map',
    (g) => (g.testCoverage['case-000000']['src/shared.ts'].map = 'nope'),
  ],
  [
    'collection unknown map',
    (g) =>
      (g.collectionCoverage['test/a.test.ts']['src/shared.ts'].map = 'nope'),
  ],
  ['collectionCoverage missing', (g) => delete g.collectionCoverage],
  ['testCoverage missing', (g) => delete g.testCoverage],
  ['extra top-level key', (g) => (g.notes = 'x')],
  ['extra nested key', (g) => (g.results['case-000000'].note = 'x')],
  [
    'prototype key',
    (g) =>
      Object.defineProperty(g.results, '__proto__', {
        enumerable: true,
        value: { file: 'f', fullName: 'n', id: 'i', state: 'passed' },
      }),
  ],
  ['not an object', (g) => Object.keys(g).forEach((key) => delete g[key])],
]

describe('stored-graph guard', () => {
  for (const [name, mutate] of mutations) {
    test(`agrees with the RuntimeGraph Schema: ${name}`, () => {
      const graph = base()
      mutate(graph)
      expect(isStoredGraph(graph), name).toBe(matchesRuntimeGraphSchema(graph))
    })
  }

  test('rejects everything that is not an object', () => {
    for (const value of [null, undefined, 1, 'graph', [], true]) {
      expect(isStoredGraph(value)).toBe(false)
      expect(matchesRuntimeGraphSchema(value)).toBe(false)
    }
  })

  test('accepts the valid graph', () => {
    expect(isStoredGraph(base())).toBe(true)
  })
})
