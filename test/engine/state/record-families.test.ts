import { describe, expect, test } from 'vitest'

import {
  isCoverageFamily,
  RECORD_FAMILIES,
  type RecordFamily,
  type TiaRuntimeGraph,
} from '../../../src/core/runtime.ts'
import {
  mergeFamilies,
  mergePartitionedGraphs,
} from '../../../src/engine/state/merge.ts'
import { mergeConcurrentGraphs } from '../../../src/engine/state/reconcile.ts'
import {
  SEGMENT_DOMAINS,
  serializeGraph,
} from '../../../src/engine/state/segments.ts'
import { baseGraph } from '../support/graphs.ts'

// A graph field is either a header field or a record family. The families
// drive the segment domains and both merges, so a new family needs no edit
// there. These tests walk RECORD_FAMILIES instead of naming each family.

const HEADER = [
  'baseline',
  'complete',
  'coverageComplete',
  'fingerprint',
  'partition',
  'schema',
  'updatedAt',
]

const KEYED = RECORD_FAMILIES.filter((family) => family !== 'coverageMaps')

/** A value that is valid for any keyed family, distinguished by `tag`. */
function sample(family: RecordFamily, tag: string): unknown {
  return isCoverageFamily(family)
    ? { 'src/a.ts': { b: {}, f: {}, map: tag, s: {} } }
    : [tag]
}

function withEntry(
  graph: TiaRuntimeGraph,
  family: RecordFamily,
  key: string,
  value: unknown,
): TiaRuntimeGraph {
  const copy = structuredClone(graph)
  Object.assign(copy[family], { [key]: value })
  return copy
}

function fragment(index: number): TiaRuntimeGraph {
  return baseGraph({
    complete: false,
    partition: { index, total: 2 },
  })
}

describe('record families', () => {
  test('are every graph field that is not a header field', () => {
    const graph = baseGraph({ partition: { index: 1, total: 2 } })
    expect([...RECORD_FAMILIES].sort()).toEqual(
      Object.keys(graph)
        .filter((key) => !HEADER.includes(key))
        .sort(),
    )
  })

  test('are the segment domains, in order, plus the working tree', () => {
    expect([...SEGMENT_DOMAINS]).toEqual([...RECORD_FAMILIES, 'workingTree'])
  })

  test('keep the manifest to the header fields', () => {
    const generator = serializeGraph(
      baseGraph({ partition: { index: 1, total: 2 } }),
    )
    let step = generator.next()
    while (step.done !== true) step = generator.next()
    expect(Object.keys(step.value.metadata)).toEqual(HEADER)
    expect(Object.keys(step.value.segments)).toEqual([...SEGMENT_DOMAINS])
  })

  describe.each(KEYED)('%s', (family) => {
    test('merges partitions that add different keys', () => {
      const merged = mergePartitionedGraphs([
        withEntry(fragment(1), family, 'one', sample(family, 'a')),
        withEntry(fragment(2), family, 'two', sample(family, 'b')),
      ])
      expect(Object.keys(merged?.[family] ?? {})).toContain('one')
      expect(Object.keys(merged?.[family] ?? {})).toContain('two')
    })

    test('refuses partitions that disagree on a key', () => {
      expect(
        mergePartitionedGraphs([
          withEntry(fragment(1), family, 'key', sample(family, 'a')),
          withEntry(fragment(2), family, 'key', sample(family, 'b')),
        ]),
      ).toBeNull()
    })

    test('merges concurrent writers that add different keys', () => {
      const expected = baseGraph()
      const merged = mergeConcurrentGraphs(
        expected,
        withEntry(expected, family, 'ours', sample(family, 'a')),
        withEntry(expected, family, 'theirs', sample(family, 'b')),
      )
      expect(Object.keys(merged?.[family] ?? {})).toEqual(
        expect.arrayContaining(['ours', 'theirs']),
      )
    })

    test('refuses concurrent writers that change a key differently', () => {
      const expected = baseGraph()
      expect(
        mergeConcurrentGraphs(
          expected,
          withEntry(expected, family, 'key', sample(family, 'a')),
          withEntry(expected, family, 'key', sample(family, 'b')),
        ),
      ).toBeNull()
    })
  })

  test('pool content-addressed maps instead of conflict-checking them', () => {
    const left = baseGraph()
    const right = baseGraph()
    const template = {
      b: {},
      branchMap: {},
      f: {},
      fnMap: {},
      s: {},
      statementMap: {},
    }
    left.coverageMaps = { same: template }
    right.coverageMaps = { same: { ...template, s: { 0: 0 } } }
    expect(mergeFamilies(null, left, right)).toBe(true)
  })
})
