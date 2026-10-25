import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterAll, describe, expect, test } from 'vitest'

import { Baselines, GraphStore } from '../../src/engine/ports.ts'
import { GraphStoreMemory } from '../../src/engine/state/memory-store.ts'
import { assertNoLeak } from '../support/leak.ts'
import { baseGraph, coverageGraph } from './support/graphs.ts'
import { EngineLive } from './support/layers.ts'
import { cleanupScratch, put, repository } from './support/repos.ts'

// The store and the baselines hold nothing across operations. Each
// loop runs on one shared runtime, as production does, and must not retain
// heap per operation.

async function noLeak(
  operation: () => unknown,
  options: Parameters<typeof assertNoLeak>[1],
): Promise<number> {
  // assertNoLeak throws when growth exceeds options.bytesPerOperation.
  return (await assertNoLeak(operation, options)).bytesPerOperation
}

const live = ManagedRuntime.make(EngineLive)
const memory = ManagedRuntime.make(GraphStoreMemory)
const directories: string[] = []

afterAll(async () => {
  await live.dispose()
  await memory.dispose()
  cleanupScratch()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('memory', () => {
  test('graph reads and commits retain nothing (live store)', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'tia-leak-'))
    directories.push(cacheDir)
    const graph = coverageGraph(60)
    await live.runPromise(
      Effect.flatMap(GraphStore, (store) =>
        store.commit(cacheDir, { expected: null, expectedDigest: null, graph }),
      ),
    )
    let revision = 0
    expect(
      await noLeak(
        () =>
          live.runPromise(
            Effect.gen(function* () {
              const store = yield* GraphStore
              const stored = yield* store.read(cacheDir)
              revision += 1
              const next = {
                ...(stored.graph ?? graph),
                updatedAt: `r${revision}`,
              }
              yield* store.commit(cacheDir, {
                expected: stored.graph,
                expectedDigest: stored.digest,
                graph: next,
              })
            }),
          ),
        { bytesPerOperation: 2_048, iterations: 60 },
      ),
    ).toBeLessThan(100_000)
  }, 120_000)

  test('the memory store does not accumulate superseded graphs', async () => {
    const graph = baseGraph()
    let revision = 0
    expect(
      await noLeak(
        () =>
          memory.runPromise(
            Effect.gen(function* () {
              const store = yield* GraphStore
              const stored = yield* store.read('/leak')
              revision += 1
              yield* store.commit('/leak', {
                expected: stored.graph,
                expectedDigest: stored.digest,
                graph: { ...graph, updatedAt: `r${revision}` },
              })
            }),
          ),
        { bytesPerOperation: 512, iterations: 500 },
      ),
    ).toBeLessThan(100_000)
  })

  test('a failed commit releases its lock and holds nothing', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'tia-leak-'))
    directories.push(cacheDir)
    const graph = baseGraph()
    const invalid: typeof graph & { bad?: bigint } = { ...graph, bad: 1n }
    expect(
      await noLeak(
        () =>
          live
            .runPromise(
              Effect.flatMap(GraphStore, (store) =>
                store.commit(cacheDir, {
                  expected: null,
                  expectedDigest: null,
                  graph: invalid,
                }),
              ),
            )
            .then(
              () => expect.unreachable('the commit should fail'),
              () => undefined,
            ),
        { bytesPerOperation: 2_048, iterations: 40 },
      ),
    ).toBeLessThan(100_000)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(cacheDir, 'state.lock'))).toBe(false)
  })

  test('baseline capture leaves no child processes or heap behind', async () => {
    const root = repository({ 'src/a.ts': 'a\n' })
    put(root, 'src/dirty.ts', 'dirty\n')
    expect(
      await noLeak(
        () =>
          live.runPromise(
            Effect.gen(function* () {
              const baselines = yield* Baselines
              const baseline = yield* baselines.capture(root, [])
              yield* baselines.changedSince(root, baseline!, [])
            }),
          ),
        { bytesPerOperation: 4_096, iterations: 25 },
      ),
    ).toBeLessThan(100_000)
  }, 120_000)

  test('the layers build and dispose repeatedly without growth', async () => {
    expect(
      await noLeak(
        async () => {
          const runtime = ManagedRuntime.make(Layer.mergeAll(GraphStoreMemory))
          await runtime.runPromise(
            Effect.flatMap(GraphStore, (s) => s.read('/x')),
          )
          await runtime.dispose()
        },
        { bytesPerOperation: 4_096, iterations: 100 },
      ),
    ).toBeLessThan(100_000)
  })
})
