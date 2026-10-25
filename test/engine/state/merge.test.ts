import { describe, expect, test } from 'vitest'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { mergePartitionedGraphs } from '../../../src/engine/state/merge.ts'
import { baseGraph } from '../support/graphs.ts'

// Port of 1.x test/unit/engine/merge.test.ts.

function fragment(index: number, total = 2): TiaRuntimeGraph {
  const id = `case-${index}`
  const file = `test/${index}.test.ts`
  return baseGraph({
    baseline: { sha: 'abc', workingTree: {} },
    collectionCoverage: { [file]: {} },
    complete: false,
    coverageComplete: true,
    edges: { [file]: [`src/${index}.ts`, file] },
    fingerprint: 'same',
    partition: { index, total },
    results: {
      [id]: { file, fullName: id, id, state: 'passed' },
    },
    testCoverage: { [id]: {} },
    testEdges: { [id]: { file, files: [`src/${index}.ts`, file] } },
    updatedAt: `2026-07-${20 + index}T00:00:00.000Z`,
  })
}

describe('partial graph merging', () => {
  test('promotes one complete, compatible set of partitions', () => {
    const merged = mergePartitionedGraphs([fragment(2), fragment(1)])

    expect(merged).toMatchObject({
      complete: true,
      coverageComplete: true,
      coverageMaps: {},
      fingerprint: 'same',
      schema: 6,
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
    expect(merged?.partition).toBeUndefined()
    expect(Object.keys(merged?.results ?? {})).toEqual(['case-1', 'case-2'])
    expect(Object.keys(merged?.testCoverage ?? {})).toEqual([
      'case-1',
      'case-2',
    ])
  })

  test('rejects missing, mismatched, duplicate, and conflicting partitions', () => {
    expect(mergePartitionedGraphs([fragment(1)])).toBeNull()

    const mismatched = fragment(2)
    mismatched.baseline.sha = 'different'
    expect(mergePartitionedGraphs([fragment(1), mismatched])).toBeNull()

    const conflict = fragment(1)
    conflict.results['case-1']!.state = 'failed'
    expect(
      mergePartitionedGraphs([fragment(1), conflict, fragment(2)]),
    ).toBeNull()
  })

  test('returns null for no fragments or a first fragment without a partition (STATE-MERGE-01)', () => {
    expect(mergePartitionedGraphs([])).toBeNull()
    const whole = fragment(1)
    delete whole.partition
    expect(mergePartitionedGraphs([whole, fragment(1), fragment(2)])).toBeNull()
  })

  test('skips fragments that are complete or differ in group, total or fingerprint (STATE-MERGE-02)', () => {
    const odd = [
      Object.assign(fragment(2), { complete: true }),
      Object.assign(fragment(2), { fingerprint: 'other' }),
      Object.assign(fragment(2), {
        partition: { group: 'x', index: 2, total: 2 },
      }),
      Object.assign(fragment(2), { partition: { index: 2, total: 3 } }),
    ]
    for (const stranger of odd) {
      expect(mergePartitionedGraphs([fragment(1), stranger])).toBeNull()
      expect(
        mergePartitionedGraphs([fragment(1), stranger, fragment(2)]),
      ).not.toBeNull()
    }
  })

  test('accepts a repeated index with an identical graph (STATE-MERGE-03)', () => {
    expect(
      mergePartitionedGraphs([fragment(1), fragment(1), fragment(2)]),
    ).not.toBeNull()
  })

  test('skips indexes outside 1..total as the Lean model does', () => {
    for (const index of [0, 3, -1, 1.5]) {
      const outside = fragment(1)
      outside.partition = { index, total: 2 }
      expect(
        mergePartitionedGraphs([fragment(1), outside, fragment(2)]),
      ).not.toBeNull()
      expect(mergePartitionedGraphs([fragment(1), outside])).toBeNull()
    }
  })

  test('rejects a partition set of zero shards, which the model accepts vacuously', () => {
    const empty = fragment(1)
    empty.partition = { index: 1, total: 0 }
    expect(mergePartitionedGraphs([empty])).toBeNull()
  })

  test('refuses overlapping keys that disagree across indexes (STATE-MERGE-06)', () => {
    const first = fragment(1)
    const second = fragment(2)
    second.edges['test/1.test.ts'] = ['src/other.ts']
    expect(mergePartitionedGraphs([first, second])).toBeNull()
    second.edges['test/1.test.ts'] = [...first.edges['test/1.test.ts']!]
    expect(mergePartitionedGraphs([first, second])).not.toBeNull()
  })

  test('ands coverageComplete, takes the first fragment identity and prunes maps (STATE-MERGE-05)', () => {
    const first = fragment(1)
    const second = fragment(2)
    second.coverageComplete = false
    first.coverageMaps = { unreferenced: baseGraph().coverageMaps as never }
    const merged = mergePartitionedGraphs([first, second])
    expect(merged?.coverageComplete).toBe(false)
    expect(merged?.complete).toBe(true)
    expect(merged?.coverageMaps).toEqual({})
    expect(merged?.baseline).toEqual(first.baseline)
    expect(merged?.baseline).not.toBe(first.baseline)
  })
})
