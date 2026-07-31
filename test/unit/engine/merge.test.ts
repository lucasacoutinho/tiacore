import { describe, expect, test } from 'vitest'

import { mergePartitionedGraphs } from '../../../src/engine/state/merge.js'
import type { TiaRuntimeGraph } from '../../../src/shared/types.js'

function fragment(index: number, total = 2): TiaRuntimeGraph {
  const id = `case-${index}`
  const file = `test/${index}.test.ts`
  return {
    baseline: { sha: 'abc', workingTree: {} },
    collectionCoverage: { [file]: {} },
    complete: false,
    coverageComplete: true,
    edges: { [file]: [`src/${index}.ts`, file] },
    fingerprint: 'same',
    partition: { index, total },
    results: {
      [id]: {
        file,
        fullName: id,
        id,
        state: 'passed',
      },
    },
    schema: 3,
    testCoverage: { [id]: {} },
    testEdges: {
      [id]: { file, files: [`src/${index}.ts`, file] },
    },
    updatedAt: `2026-07-${20 + index}T00:00:00.000Z`,
  }
}

describe('partial graph merging', () => {
  test('promotes one complete, compatible set of partitions', () => {
    const merged = mergePartitionedGraphs([fragment(2), fragment(1)])

    expect(merged).toMatchObject({
      complete: true,
      coverageComplete: true,
      fingerprint: 'same',
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
})
