import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  aggregateLocalPartitions,
  partitionCacheDir,
} from '../src/graph/partitions.js'
import {
  graphPath,
  readGraph,
  writeGraph,
} from '../src/graph/state.js'
import type {
  TiaGraph,
  TiaGraphPartition,
} from '../src/shared/types.js'

const temporaryDirectories: string[] = []

function fragment(
  partition: TiaGraphPartition,
): TiaGraph {
  const id = `case-${partition.index}`
  const file = `test/${partition.index}.test.ts`
  return {
    baseline: { sha: 'abc', workingTree: {} },
    collectionCoverage: { [file]: {} },
    complete: false,
    coverageComplete: true,
    edges: { [file]: [file, `src/${partition.index}.ts`] },
    fingerprint: 'partition-failure-injection',
    partition,
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
      [id]: {
        file,
        files: [file, `src/${partition.index}.ts`],
      },
    },
    updatedAt: `2026-07-${20 + partition.index}T00:00:00.000Z`,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('partition promotion failure injection', () => {
  test('leaves no promoted graph for a truncated shard and succeeds on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-partitions-'))
    temporaryDirectories.push(root)
    const cacheDir = join(root, '.tia')
    const partition: TiaGraphPartition = {
      group: 'retryable-run',
      index: 1,
      total: 2,
    }
    writeGraph(
      partitionCacheDir(cacheDir, partition),
      fragment(partition),
    )
    const second = { ...partition, index: 2 }
    const truncated = graphPath(
      partitionCacheDir(cacheDir, second),
    )
    mkdirSync(dirname(truncated), { recursive: true })
    writeFileSync(truncated, '{"schema":3')

    await expect(
      aggregateLocalPartitions(cacheDir, partition),
    ).resolves.toBeNull()
    expect(readGraph(cacheDir)).toBeNull()

    writeGraph(
      partitionCacheDir(cacheDir, second),
      fragment(second),
    )
    const promoted = await aggregateLocalPartitions(
      cacheDir,
      partition,
    )

    expect(promoted).toMatchObject({
      complete: true,
      coverageComplete: true,
    })
    expect(Object.keys(readGraph(cacheDir)?.results ?? {})).toEqual([
      'case-1',
      'case-2',
    ])
  })
})
