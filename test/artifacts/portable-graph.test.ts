import { describe, expect, test } from 'vitest'

import {
  GRAPH_SCHEMA_VERSION,
  type TiaRuntimeGraph,
} from '../../src/core/runtime.ts'
import {
  parseArtifactGraph,
  portableGraphBytes,
} from '../../src/engine/artifacts/portable-graph.ts'
import {
  coverageMapId,
  coverageTemplate,
} from '../../src/engine/state/coverage.ts'
import { baseGraph } from '../engine/support/graphs.ts'

// Portable artifacts use schema 3 and restore into the current runtime schema.

function location(line: number) {
  return { end: { column: 9, line }, start: { column: 0, line } }
}

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
      0: { decl: location(1), line: 1, loc: location(1), name: 'example' },
    },
    s: { 0: 0, 1: 0 },
    statementMap: { 0: location(1), 1: location(2) },
  })
  const map = coverageMapId(template)
  return baseGraph({
    baseline: { sha: 'abc', source: 'git', workingTree: {} },
    collectionCoverage: {
      'test/a.test.ts': { 'src/a.ts': { b: {}, f: {}, map, s: { 0: 1 } } },
    },
    coverageComplete: true,
    coverageMaps: { [map]: template },
    fingerprint: 'fixture',
    testCoverage: {
      a: { 'src/a.ts': { b: { 0: [0, 3] }, f: { 0: 1 }, map, s: { 1: 2 } } },
    },
    updatedAt: '2026-10-11T00:00:00.000Z',
  })
}

describe('portable artifact graphs', () => {
  test('publish complete Istanbul coverage in the schema-3 layout', () => {
    const value = graph()
    const template = Object.values(value.coverageMaps)[0]!
    const portable = JSON.parse(
      portableGraphBytes(value, 1024 * 1024).toString('utf8'),
    ) as Record<string, unknown> & {
      testCoverage: Record<string, Record<string, unknown>>
    }

    expect(portable['schema']).toBe(3)
    expect(portable).not.toHaveProperty('coverageMaps')
    expect(portable.testCoverage['a']?.['src/a.ts']).toEqual({
      b: { 0: [0, 3] },
      branchMap: template.branchMap,
      f: { 0: 1 },
      fnMap: template.fnMap,
      path: 'src/a.ts',
      s: { 0: 0, 1: 2 },
      statementMap: { 0: location(1), 1: location(2) },
    })
    expect(
      portableGraphBytes(value, 1024 * 1024)
        .toString('utf8')
        .endsWith('}\n'),
    ).toBe(true)
  })

  test('restore schema-3 artifacts into the shared-map runtime layout', () => {
    const value = graph()

    expect(
      parseArtifactGraph(
        portableGraphBytes(value, 1024 * 1024).toString('utf8'),
      ),
    ).toEqual({ ...value, schema: GRAPH_SCHEMA_VERSION })
    expect(parseArtifactGraph(value)).toEqual(value)
    expect(parseArtifactGraph(JSON.stringify(value))).toEqual(value)
  })

  test('stop expanding as soon as the artifact limit is passed', () => {
    expect(() => portableGraphBytes(graph(), 256)).toThrow(
      'TIA graph exceeds the artifact graph limit',
    )
  })

  test('reject schema-3 coverage that is not Istanbul file coverage', () => {
    const portable = JSON.parse(
      portableGraphBytes(graph(), 1024 * 1024).toString('utf8'),
    ) as { testCoverage: Record<string, Record<string, unknown>> }
    portable.testCoverage['a'] = { 'src/a.ts': { s: { 0: 'x' } } }

    expect(parseArtifactGraph(portable)).toBeNull()
  })

  test('names the file whose coverage map is missing', () => {
    const value = graph()
    value.coverageMaps = {}
    expect(() => portableGraphBytes(value, 1024 * 1024)).toThrow(
      'TIA graph names a missing coverage map: src/a.ts',
    )
  })

  test('rejects invalid JSON, other schemas and a coverage key that would replace a prototype', () => {
    expect(parseArtifactGraph('{')).toBeNull()
    expect(parseArtifactGraph({ ...graph(), schema: 4 })).toBeNull()
    expect(parseArtifactGraph(null)).toBeNull()
    const portable = JSON.parse(
      portableGraphBytes(graph(), 1024 * 1024).toString('utf8'),
    ) as Record<string, unknown>
    const text = JSON.stringify(portable).replace(
      '"a":{"src',
      '"__proto__":{"src',
    )
    expect(parseArtifactGraph(text)).toBeNull()
  })

  test('omits undefined values and keeps the partition of a fragment', () => {
    const value = graph()
    value.partition = { group: 'g', index: 1, total: 2 }
    value.complete = false
    const restored = parseArtifactGraph(
      portableGraphBytes(value, 1024 * 1024).toString('utf8'),
    )
    expect(restored?.partition).toEqual({ group: 'g', index: 1, total: 2 })
  })
})
