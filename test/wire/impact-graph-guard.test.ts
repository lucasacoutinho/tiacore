import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { describe, expect, test } from 'vitest'

import { canonicalGraph } from '../../src/core/canonical.ts'
import type { TiaImpactGraph } from '../../src/core/protocol.ts'
import { acceptImpactGraph } from '../../src/wire/impact-graph-guard.ts'
import { ImpactGraph } from '../../src/wire/protocol.ts'

// The guard is an accelerator for the ImpactGraph Schema: on every value it
// must accept exactly what the Schema accepts and decode it to the same graph.
// Every leaf of a graph that uses every field is replaced with each value of a
// grid, deleted, or joined by an unknown key; arrays also get a duplicate.

const decode = Schema.decodeUnknownExit(ImpactGraph)

function schema(value: unknown): TiaImpactGraph | null {
  const exit = decode(value, { onExcessProperty: 'error' })
  return Exit.isSuccess(exit) ? canonicalGraph(exit.value) : null
}

function guard(value: unknown): TiaImpactGraph | null {
  const graph = acceptImpactGraph(value)
  return graph === null ? null : canonicalGraph(graph)
}

const base = (): Record<string, unknown> => ({
  complete: true,
  environmentFingerprint: '',
  fingerprint: 'fp',
  invalidators: [
    { pattern: '**/*.lock', reason: 'lock changed' },
    { pattern: 'config/**', reason: 'configuration changed' },
  ],
  knownSources: ['./docs/readme.md', 'src//shared.ts'],
  observations: [
    { confidence: 'exact', kind: 'import', source: 'src/a.ts', suiteId: 'a' },
    {
      confidence: 'observed',
      kind: 'executed',
      source: './src/b.ts',
      suiteId: 'b',
    },
  ],
  protocolVersion: 1,
  suites: [
    {
      adapter: 'vitest',
      dependsOn: ['b'],
      file: 'test/a.test.ts',
      id: 'a',
      project: 'unit',
      resourceLocks: ['db'],
      tags: ['fast', 'smoke'],
    },
    { adapter: 'vitest', file: './test/b.test.ts', id: 'b', project: 'unit' },
  ],
})

const GRID: readonly unknown[] = [
  null,
  undefined,
  true,
  false,
  0,
  1,
  2,
  -1,
  1.5,
  Number.NaN,
  '',
  ' ',
  'x',
  'a',
  'b',
  '../escape',
  '/absolute',
  'C:\\\\win',
  'src/../src/a.ts',
  'x'.repeat(4_097),
  'y'.repeat(8_193),
  'import',
  'exact',
  [],
  ['a'],
  {},
]

type Path = readonly (number | string)[]

function leaves(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) {
    return [
      path,
      ...value.flatMap((item, index) => leaves(item, [...path, index])),
    ]
  }
  if (value !== null && typeof value === 'object') {
    return [
      path,
      ...Object.entries(value).flatMap(([key, item]) =>
        leaves(item, [...path, key]),
      ),
    ]
  }
  return [path]
}

function edit(
  root: Record<string, unknown>,
  path: Path,
  change: (
    parent: Record<string | number, unknown>,
    key: string | number,
  ) => void,
): void {
  let parent: Record<string | number, unknown> = root
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string | number, unknown>
  }
  const key = path.at(-1)
  if (key !== undefined) change(parent, key)
}

function variants(): Array<[string, unknown]> {
  const cases: Array<[string, unknown]> = [['base', base()]]
  for (const path of leaves(base())) {
    if (path.length === 0) continue
    const name = path.join('.')
    for (const value of GRID) {
      const graph = base()
      edit(graph, path, (parent, key) => {
        parent[key] = value
      })
      cases.push([`${name} = ${String(value).slice(0, 12)}`, graph])
    }
    const deleted = base()
    edit(deleted, path, (parent, key) => {
      if (Array.isArray(parent)) parent.splice(Number(key), 1)
      else delete parent[key]
    })
    cases.push([`${name} deleted`, deleted])
    const graph = base()
    let target: unknown = graph
    for (const key of path)
      target = (target as Record<string | number, unknown>)[key]
    if (Array.isArray(target) && target.length > 0) {
      target.push(structuredClone(target[0]))
      cases.push([`${name} duplicated`, graph])
    } else if (target !== null && typeof target === 'object') {
      ;(target as Record<string, unknown>)['unknown'] = 1
      cases.push([`${name} unknown key`, graph])
    }
  }
  const unknownTop = base()
  unknownTop['extra'] = true
  cases.push(['unknown top-level key', unknownTop])
  const cycle = base()
  ;(
    (cycle['suites'] as Record<string, unknown>[])[1] as Record<string, unknown>
  )['dependsOn'] = ['a']
  cases.push(['dependency cycle', cycle])
  const selfCycle = base()
  ;(
    (selfCycle['suites'] as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >
  )['dependsOn'] = ['a']
  cases.push(['self dependency', selfCycle])
  const sameCanonical = base()
  sameCanonical['knownSources'] = ['src/x.ts', './src/x.ts']
  cases.push(['duplicate after canonicalization', sameCanonical])
  return cases
}

describe('the impact graph guard', () => {
  const cases = variants()

  test('agrees with the Schema on every variant', () => {
    const disagreements: string[] = []
    for (const [name, value] of cases) {
      const expected = schema(structuredClone(value))
      const actual = guard(structuredClone(value))
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        disagreements.push(
          `${name}: guard ${actual === null ? 'rejects' : 'accepts'}, Schema ${expected === null ? 'rejects' : 'accepts'}`,
        )
      }
    }
    expect(disagreements).toEqual([])
  })

  test('covers both outcomes, so the sweep means something', () => {
    const accepted = cases.filter(
      ([, value]) => guard(structuredClone(value)) !== null,
    )
    expect(cases.length).toBeGreaterThan(1_000)
    expect(accepted.length).toBeGreaterThan(50)
    expect(cases.length - accepted.length).toBeGreaterThan(500)
  })

  test('decodes paths to their canonical form', () => {
    const graph = guard(base())
    expect(graph?.knownSources).toEqual(['docs/readme.md', 'src/shared.ts'])
    expect(graph?.suites.map((suite) => suite.file)).toEqual([
      'test/a.test.ts',
      'test/b.test.ts',
    ])
  })
})
