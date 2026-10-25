import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import type { PlatformError } from 'effect/PlatformError'
import type * as Scope from 'effect/Scope'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, layer, test } from '@effect/vitest'

import type {
  Baseline,
  TiaRuntimeGraph,
  TiaRuntimeGraphPartition,
} from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import { GraphStoreMemory } from '../../../src/engine/state/memory-store.ts'
import {
  aggregateLocalPartitions,
  partitionCacheDir,
  partitionGroup,
} from '../../../src/engine/state/partitions.ts'
import { legacy } from '../../support/legacy.ts'
import { baseGraph } from '../support/graphs.ts'
import { EngineLive, tempDirectory } from '../support/layers.ts'

// Port of 1.x test/unit/engine/partitions.test.ts, plus STATE-PART-01..05.

const oracle = await legacy<{
  partitionCacheDir: (
    cacheDir: string,
    partition: TiaRuntimeGraphPartition,
  ) => string
  partitionGroup: (
    baseline: Baseline | null,
    fingerprint: string,
    total: number,
    requested?: string,
  ) => string
}>('engine/state/partitions.js')

function fragment(partition: TiaRuntimeGraphPartition): TiaRuntimeGraph {
  const id = `case-${partition.index}`
  const file = `test/${partition.index}.test.ts`
  return baseGraph({
    baseline: { sha: 'abc', workingTree: {} },
    collectionCoverage: { [file]: {} },
    complete: false,
    coverageComplete: true,
    edges: { [file]: [file, `src/${partition.index}.ts`] },
    fingerprint: 'partition-failure-injection',
    partition,
    results: { [id]: { file, fullName: id, id, state: 'passed' } },
    testCoverage: { [id]: {} },
    testEdges: { [id]: { file, files: [file, `src/${partition.index}.ts`] } },
    updatedAt: `2026-07-${20 + partition.index}T00:00:00.000Z`,
  })
}

const save = (cacheDir: string, graph: TiaRuntimeGraph) =>
  Effect.flatMap(GraphStore, (store) =>
    store.commit(cacheDir, { expected: null, expectedDigest: null, graph }),
  )

const readMain = (cacheDir: string) =>
  Effect.map(
    Effect.flatMap(GraphStore, (store) => store.read(cacheDir)),
    (stored) => stored.graph,
  )

describe('partition naming', () => {
  test('matches 1.x group and directory names', () => {
    const baseline: Baseline = {
      sha: 'abc',
      source: 'git',
      workingTree: { 'a.ts': 'h' },
    }
    for (const requested of [undefined, '', '   ', ' ci-run ', 'ci']) {
      expect(partitionGroup(baseline, 'fp', 3, requested)).toBe(
        oracle.partitionGroup(baseline, 'fp', 3, requested),
      )
    }
    expect(partitionGroup(null, 'fp', 2)).toBe(
      oracle.partitionGroup(null, 'fp', 2),
    )
    expect(partitionGroup(baseline, 'fp', 3, ' ci-run ')).toBe('ci-run')
    expect(partitionGroup(baseline, 'fp', 3)).toMatch(/^local-[a-f0-9]{20}$/u)
    for (const group of [undefined, 'g', 'local-1']) {
      const partition = {
        ...(group === undefined ? {} : { group }),
        index: 2,
        total: 3,
      }
      expect(partitionCacheDir('/cache', partition)).toBe(
        oracle.partitionCacheDir('/cache', partition),
      )
    }
  })

  test('local groups differ when the dirty tree differs (STATE-PART-02)', () => {
    const a: Baseline = { sha: 'abc', source: 'git', workingTree: {} }
    const b: Baseline = {
      sha: 'abc',
      source: 'git',
      workingTree: { 'x.ts': 'h' },
    }
    expect(partitionGroup(a, 'fp', 2)).not.toBe(partitionGroup(b, 'fp', 2))
    expect(partitionGroup(a, 'fp', 2)).not.toBe(partitionGroup(a, 'fp', 3))
  })
})

function aggregation(
  name: string,
  provide: Layer.Layer<GraphStore | FileSystem.FileSystem>,
  directory: () => Effect.Effect<
    string,
    PlatformError,
    FileSystem.FileSystem | Scope.Scope
  >,
) {
  layer(provide, { excludeTestServices: true })(name, (it) => {
    it.effect(
      'leaves no promoted graph for a missing shard and promotes on retry',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const partition: TiaRuntimeGraphPartition = {
            group: 'retryable-run',
            index: 1,
            total: 2,
          }
          yield* save(
            partitionCacheDir(cacheDir, partition),
            fragment(partition),
          )
          const second = { ...partition, index: 2 }

          expect(
            yield* aggregateLocalPartitions(cacheDir, partition),
          ).toBeNull()
          expect(yield* readMain(cacheDir)).toBeNull()

          yield* save(partitionCacheDir(cacheDir, second), fragment(second))
          const promoted = yield* aggregateLocalPartitions(cacheDir, partition)
          expect(promoted).toMatchObject({
            complete: true,
            coverageComplete: true,
            coverageMaps: {},
          })
          expect(
            Object.keys((yield* readMain(cacheDir))?.results ?? {}),
          ).toEqual(['case-1', 'case-2'])
        }),
    )

    it.effect(
      'never combines shards of another group or total (STATE-PART-05)',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const one: TiaRuntimeGraphPartition = {
            group: 'one',
            index: 1,
            total: 2,
          }
          const other: TiaRuntimeGraphPartition = {
            group: 'two',
            index: 2,
            total: 2,
          }
          yield* save(partitionCacheDir(cacheDir, one), fragment(one))
          yield* save(
            partitionCacheDir(cacheDir, { ...one, index: 2 }),
            fragment(other),
          )
          expect(yield* aggregateLocalPartitions(cacheDir, one)).toBeNull()
          expect(yield* readMain(cacheDir)).toBeNull()
        }),
    )
  })
}

aggregation('local partition aggregation, live store', EngineLive, () =>
  tempDirectory('tia-parts-'),
)
aggregation(
  'local partition aggregation, memory store',
  Layer.mergeAll(GraphStoreMemory, NodeServices.layer),
  () => Effect.succeed(join('/memory', String(Math.random()))),
)

layer(EngineLive, { excludeTestServices: true })('truncated shard', (it) => {
  it.effect(
    'leaves no promoted graph for a truncated shard and succeeds on retry',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-parts-')
        const partition: TiaRuntimeGraphPartition = {
          group: 'retryable-run',
          index: 1,
          total: 2,
        }
        yield* save(partitionCacheDir(cacheDir, partition), fragment(partition))
        const second = { ...partition, index: 2 }
        const directory = partitionCacheDir(cacheDir, second)
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* fs.writeFileString(join(directory, 'state.json'), '{"schema":3')
        expect(yield* aggregateLocalPartitions(cacheDir, partition)).toBeNull()
        expect(yield* readMain(cacheDir)).toBeNull()

        yield* fs.remove(directory, { force: true, recursive: true })
        yield* save(partitionCacheDir(cacheDir, second), fragment(second))
        const promoted = yield* aggregateLocalPartitions(cacheDir, partition)
        expect(promoted).toMatchObject({
          complete: true,
          coverageComplete: true,
          coverageMaps: {},
        })
        expect(Object.keys((yield* readMain(cacheDir))?.results ?? {})).toEqual(
          ['case-1', 'case-2'],
        )
      }),
  )
})
