import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterAll, describe, expect, test } from 'vitest'

import { restoreGraph } from '../../src/engine/artifacts/restore.ts'
import { readArtifactArchive } from '../../src/engine/artifacts/archive.ts'
import { portableGraphBytes } from '../../src/engine/artifacts/portable-graph.ts'
import { writeArtifactArchive } from '../../src/engine/artifacts/archive.ts'
import { baselinesMemory } from '../../src/engine/baseline/memory.ts'
import { GraphStore } from '../../src/engine/ports.ts'
import { GraphStoreMemory } from '../../src/engine/state/memory-store.ts'
import { assertNoLeak } from '../support/leak.ts'
import { coverageGraph } from '../engine/support/graphs.ts'

// NF-MEM: artifact restore and the archive codec hold nothing across runs.

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    GraphStoreMemory,
    baselinesMemory(
      new Map([
        ['/project', { commits: [{ files: {}, sha: 'old' }], files: {} }],
      ]),
    ),
  ),
)

afterAll(async () => {
  await runtime.dispose()
})

describe('artifact memory', () => {
  test('restoring from a provider retains nothing', async () => {
    const graph = {
      ...coverageGraph(40),
      baseline: { sha: 'old', source: 'git' as const, workingTree: {} },
    }
    const result = await assertNoLeak(
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const outcome = yield* restoreGraph({
              cacheDir: '/cache',
              fingerprint: graph.fingerprint,
              log: false,
              providers: [{ load: () => ({ graph, id: 1 }), name: 'memory' }],
              root: '/project',
              trust: { allowUnsigned: true },
            })
            expect(outcome.restored).toBe(true)
            yield* (yield* GraphStore).purge('/cache')
          }),
        ),
      { bytesPerOperation: 4_096, iterations: 40 },
    )
    expect(result.bytesPerOperation).toBeLessThan(4_096)
  })

  test('reading and writing archives retains nothing', async () => {
    const graph = coverageGraph(40)
    const bytes = portableGraphBytes(graph, 20 * 1024 * 1024)
    const archive = writeArtifactArchive([['graph.json', bytes]])
    const result = await assertNoLeak(
      () => {
        const read = readArtifactArchive(archive, undefined)
        if (read === null) throw new Error('archive unreadable')
        return writeArtifactArchive([['graph.json', bytes]])
      },
      { bytesPerOperation: 4_096, iterations: 20 },
    )
    expect(result.bytesPerOperation).toBeLessThan(4_096)
  })
})
