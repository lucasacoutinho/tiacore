import { describe, expect, test } from 'vitest'

import {
  matchesRuntimeGraphSchema,
  RuntimeGraph,
} from '../../src/wire/runtime-graph.ts'
import { isStoredGraph } from '../../src/wire/stored-graph.ts'
import { coverageGraph } from '../engine/support/graphs.ts'

// The store validates with a hand-written guard because the Schema guard is
// five times slower on a 2,000-test graph. This test pins the two together:
// every single-point mutation of a graph that uses every field, over a grid of
// hostile values, must be accepted or rejected by both alike.

type Mutable = Record<string, any>
type Path = ReadonlyArray<number | string>

/** A valid graph in which every field of the Schema, optional ones included, is present. */
function rich(): Mutable {
  const graph = coverageGraph(3)
  graph.baseline.workingTree = { 'src/a.ts': 'hash', 'src/b.ts': '<deleted>' }
  graph.collectionCoverage['test/a.test.ts'] = {
    'src/shared.ts': {
      b: { 0: [1, 0] },
      f: { 0: 1 },
      map: 'shared',
      s: { 0: 1 },
    },
  }
  graph.collectionFiles['test/a.test.ts'] = ['src/shared.ts', 'src/setup.ts']
  graph.results['case-000000']!.duration = 12.5
  graph.partition = { group: 'g', index: 1, total: 2 }
  return graph as unknown as Mutable
}

/** Values that stand for the ways stored JSON goes wrong, plus tokens the graph accepts. */
const GRID: ReadonlyArray<readonly [string, () => unknown]> = [
  ['0', () => 0],
  ['1', () => 1],
  ['-1', () => -1],
  ['1.5', () => 1.5],
  ['2 ** 53', () => 2 ** 53],
  ['-(2 ** 53)', () => -(2 ** 53)],
  ['2 ** 60', () => 2 ** 60],
  ['MAX_SAFE_INTEGER', () => Number.MAX_SAFE_INTEGER],
  ['MIN_SAFE_INTEGER', () => Number.MIN_SAFE_INTEGER],
  ['NaN', () => Number.NaN],
  ['Infinity', () => Number.POSITIVE_INFINITY],
  ['-Infinity', () => Number.NEGATIVE_INFINITY],
  ["''", () => ''],
  ["'x'", () => 'x'],
  ["'git'", () => 'git'],
  ["'filesystem'", () => 'filesystem'],
  ["'svn'", () => 'svn'],
  ["'passed'", () => 'passed'],
  ["'failed'", () => 'failed'],
  ["'skipped'", () => 'skipped'],
  ["'weird'", () => 'weird'],
  ['true', () => true],
  ['false', () => false],
  ['[]', () => []],
  ['{}', () => ({})],
  ['null', () => null],
  ['undefined', () => undefined],
]

/** Every node below the root, as the keys that lead to it. */
function pathsOf(node: unknown, prefix: Path = []): Path[] {
  if (typeof node !== 'object' || node === null) return []
  return Object.entries(node).flatMap(([key, child]) => {
    const path = [...prefix, Array.isArray(node) ? Number(key) : key]
    return [path, ...pathsOf(child, path)]
  })
}

function parentOf(graph: Mutable, path: Path): Mutable {
  return path.slice(0, -1).reduce<Mutable>((node, key) => node[key], graph)
}

function describePath(path: Path): string {
  return path.join('.')
}

interface Mutation {
  readonly name: string
  readonly apply: (graph: Mutable) => void
}

function mutationsOf(graph: Mutable): Mutation[] {
  const mutations: Mutation[] = []
  for (const path of pathsOf(graph)) {
    const key = path[path.length - 1]!
    const where = describePath(path)
    for (const [label, make] of GRID) {
      mutations.push({
        apply: (target) => {
          parentOf(target, path)[key] = make()
        },
        name: `${where} = ${label}`,
      })
    }
    mutations.push({
      apply: (target) => {
        const parent = parentOf(target, path)
        if (Array.isArray(parent)) parent.splice(Number(key), 1)
        else delete parent[key]
      },
      name: `${where} deleted`,
    })
  }
  for (const path of [[], ...pathsOf(graph)]) {
    const node = path.reduce<unknown>(
      (current, key) => (current as Mutable)[key],
      graph,
    )
    if (typeof node !== 'object' || node === null || Array.isArray(node))
      continue
    mutations.push({
      apply: (target) => {
        path.reduce<Mutable>((current, key) => current[key], target)['extra'] =
          'x'
      },
      name: `${describePath(path)} gains an unknown key`,
    })
  }
  return mutations
}

describe('stored-graph guard', () => {
  test('accepts the rich graph, as the Schema does', () => {
    expect(isStoredGraph(rich())).toBe(true)
    expect(matchesRuntimeGraphSchema(rich())).toBe(true)
  })

  test('agrees with the RuntimeGraph Schema on every single-point mutation', () => {
    const mutations = mutationsOf(rich())
    const disagreements: string[] = []
    let accepted = 0
    for (const { apply, name } of mutations) {
      const graph = rich()
      apply(graph)
      const guard = isStoredGraph(graph)
      const schema = matchesRuntimeGraphSchema(graph)
      if (guard !== schema)
        disagreements.push(`${name}: guard ${guard}, Schema ${schema}`)
      if (schema) accepted += 1
    }
    expect(disagreements).toEqual([])
    // Both outcomes must occur often, or the pin proves nothing.
    expect(mutations.length).toBeGreaterThan(2_000)
    expect(accepted).toBeGreaterThan(50)
    expect(mutations.length - accepted).toBeGreaterThan(1_000)
  })

  test('puts every field of the Schema in the graph the mutations start from', () => {
    expect(Object.keys(rich()).sort()).toEqual(
      Object.keys(RuntimeGraph.fields).sort(),
    )
  })

  test('ignores a top-level field it does not know, as the Schema does', () => {
    const graph = rich()
    graph['futureField'] = { anything: [1] }
    expect(isStoredGraph(graph)).toBe(true)
    expect(matchesRuntimeGraphSchema(graph)).toBe(true)
  })

  test('refuses a graph that lacks any field of the Schema', () => {
    for (const field of Object.keys(RuntimeGraph.fields)) {
      if (field === 'partition') continue
      const graph = rich()
      delete graph[field]
      expect(isStoredGraph(graph), field).toBe(false)
      expect(matchesRuntimeGraphSchema(graph), field).toBe(false)
    }
  })

  test('refuses a partition whose numbers are not safe integers', () => {
    for (const partition of [
      { index: 2 ** 60, total: 2 ** 60 },
      { index: 1, total: 2 ** 53 },
      { index: 1.5, total: 2 },
    ]) {
      const graph = rich()
      graph['partition'] = partition
      expect(isStoredGraph(graph)).toBe(false)
      expect(matchesRuntimeGraphSchema(graph)).toBe(false)
    }
  })

  test('treats an enumerable __proto__ key as data, as the Schema does', () => {
    const graph = rich()
    Object.defineProperty(graph['results'], '__proto__', {
      enumerable: true,
      value: { file: 'f', fullName: 'n', id: 'i', state: 'passed' },
    })
    expect(isStoredGraph(graph)).toBe(matchesRuntimeGraphSchema(graph))
  })

  test('rejects everything that is not an object', () => {
    for (const value of [null, undefined, 1, 'graph', [], true]) {
      expect(isStoredGraph(value)).toBe(false)
      expect(matchesRuntimeGraphSchema(value)).toBe(false)
    }
  })
})
