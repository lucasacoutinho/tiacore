import { describe, expect, test } from 'vitest'

import {
  parseArtifactGraph,
  portableGraphBytes,
} from '../../../src/engine/artifacts/portable-graph.js'
import {
  coverageMapId,
  coverageTemplate,
} from '../../../src/engine/state/coverage.js'
import { emptyGraph } from '../../../src/engine/state/update.js'
import type { TiaRuntimeGraph } from '../../../src/shared/types.js'

function location(line: number) {
  return { end: { column: 9, line }, start: { column: 0, line } }
}

function graph(): TiaRuntimeGraph {
  const value = emptyGraph()
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
  value.baseline = { sha: 'abc', source: 'git', workingTree: {} }
  value.complete = true
  value.coverageComplete = true
  value.coverageMaps = { [map]: template }
  value.fingerprint = 'fixture'
  value.updatedAt = '2026-10-11T00:00:00.000Z'
  value.edges['test/a.test.ts'] = ['src/a.ts', 'test/a.test.ts']
  value.results.a = {
    file: 'test/a.test.ts',
    fullName: 'a',
    id: 'a',
    state: 'passed',
  }
  value.testEdges.a = {
    file: 'test/a.test.ts',
    files: ['src/a.ts', 'test/a.test.ts'],
  }
  value.collectionCoverage['test/a.test.ts'] = {
    'src/a.ts': { b: {}, f: {}, map, s: { 0: 1 } },
  }
  value.testCoverage.a = {
    'src/a.ts': { b: { 0: [0, 3] }, f: { 0: 1 }, map, s: { 1: 2 } },
  }
  return value
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

    expect(portable.schema).toBe(3)
    expect(portable).not.toHaveProperty('coverageMaps')
    expect(portable.testCoverage.a?.['src/a.ts']).toEqual({
      b: { 0: [0, 3] },
      branchMap: template.branchMap,
      f: { 0: 1 },
      fnMap: template.fnMap,
      path: 'src/a.ts',
      s: { 0: 0, 1: 2 },
      statementMap: { 0: location(1), 1: location(2) },
    })
  })

  test('restore schema-3 artifacts into the shared-map runtime layout', () => {
    const value = graph()

    expect(
      parseArtifactGraph(
        portableGraphBytes(value, 1024 * 1024).toString('utf8'),
      ),
    ).toEqual({ ...value, schema: 4 })
    expect(parseArtifactGraph(value)).toEqual(value)
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
    portable.testCoverage.a = { 'src/a.ts': { s: { 0: 'x' } } }

    expect(parseArtifactGraph(portable)).toBeNull()
  })
})
