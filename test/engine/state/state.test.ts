import * as NodeServices from '@effect/platform-node/NodeServices'
import { hostname } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import type { PlatformError } from 'effect/PlatformError'
import type * as Scope from 'effect/Scope'
import { expect, layer } from '@effect/vitest'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import { GraphStoreMemory } from '../../../src/engine/state/memory-store.ts'
import { graphDigest } from '../../../src/engine/state/segments.ts'
import { baseGraph } from '../support/graphs.ts'
import { EngineLive, tempDirectory } from '../support/layers.ts'

// Port of 1.x test/unit/engine/state.test.ts (STATE-TXN-*, STATE-VER-03,
// STATE-READ-09), run against the live store and the in-memory store alike.

const seed = (cacheDir: string, graph: TiaRuntimeGraph) =>
  Effect.gen(function* () {
    const store = yield* GraphStore
    const result = yield* store.commit(cacheDir, {
      expected: null,
      expectedDigest: null,
      graph,
    })
    expect(result.status).toBe('committed')
  })

const propose = (
  expected: TiaRuntimeGraph,
  edit: (graph: TiaRuntimeGraph) => void,
  millis: number,
) => {
  const graph = structuredClone(expected)
  graph.baseline.sha = 'next'
  edit(graph)
  graph.updatedAt = new Date(millis).toISOString()
  return graph
}

const commitFrom = (
  cacheDir: string,
  expected: TiaRuntimeGraph,
  graph: TiaRuntimeGraph,
  extra: { lockTimeoutMs?: number; staleLockMs?: number } = {},
) =>
  Effect.flatMap(GraphStore, (store) =>
    store.commit(cacheDir, {
      expected,
      expectedDigest: graphDigest(expected),
      graph,
      ...extra,
    }),
  )

function contract(
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
      'merges disjoint updates from processes that planned the same graph',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          const first = propose(
            expected,
            (graph) => {
              graph.results.a!.fullName = 'a updated'
            },
            1,
          )
          const second = propose(
            expected,
            (graph) => {
              graph.results.b!.fullName = 'b updated'
            },
            2,
          )
          expect((yield* commitFrom(cacheDir, expected, first)).status).toBe(
            'committed',
          )
          const merged = yield* commitFrom(cacheDir, expected, second)
          expect(merged.status).toBe('merged')
          const stored = (yield* (yield* GraphStore).read(cacheDir)).graph
          expect(stored?.results).toMatchObject({
            a: { fullName: 'a updated' },
            b: { fullName: 'b updated' },
          })
          expect(stored?.updatedAt).toBe(new Date(2).toISOString())
        }),
    )

    it.effect(
      'fails closed when concurrent writers change the same value differently',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          yield* commitFrom(
            cacheDir,
            expected,
            propose(expected, (g) => (g.results.a!.state = 'failed'), 1),
          )
          const conflict = yield* commitFrom(
            cacheDir,
            expected,
            propose(expected, (g) => (g.results.a!.state = 'skipped'), 2),
          )
          expect(conflict.status).toBe('conflict')
          expect(conflict.graph?.results.a?.state).toBe('failed')
          const stored = (yield* (yield* GraphStore).read(cacheDir)).graph
          expect(stored?.results.a?.state).toBe('failed')
        }),
    )

    it.effect(
      'agrees on a result that differs only in duration (STATE-TXN-13)',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          yield* commitFrom(
            cacheDir,
            expected,
            propose(expected, (g) => (g.results.a!.duration = 5), 1),
          )
          const second = yield* commitFrom(
            cacheDir,
            expected,
            propose(expected, (g) => (g.results.a!.duration = 9), 2),
          )
          expect(second.status).toBe('merged')
          expect(second.graph?.results.a?.duration).toBe(5)
        }),
    )

    it.effect('applies a deletion the other writer did not touch', () =>
      Effect.gen(function* () {
        const cacheDir = yield* directory()
        const expected = baseGraph()
        yield* seed(cacheDir, expected)
        yield* commitFrom(
          cacheDir,
          expected,
          propose(expected, (g) => (g.results.a!.state = 'failed'), 1),
        )
        const merged = yield* commitFrom(
          cacheDir,
          expected,
          propose(expected, (g) => delete g.results.b, 2),
        )
        expect(merged.status).toBe('merged')
        expect(Object.keys(merged.graph?.results ?? {})).toEqual(['a'])
      }),
    )

    it.effect(
      'refuses to merge writers that disagree on identity (STATE-TXN-11)',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          yield* commitFrom(
            cacheDir,
            expected,
            propose(expected, () => {}, 1),
          )
          const other = propose(
            expected,
            (g) => {
              g.fingerprint = 'other'
              g.results.b!.state = 'failed'
            },
            2,
          )
          const result = yield* commitFrom(cacheDir, expected, other)
          expect(result.status).toBe('conflict')
          expect(
            (yield* (yield* GraphStore).read(cacheDir)).graph?.fingerprint,
          ).toBe('fingerprint')
        }),
    )

    it.effect(
      'reports a conflict without locking when the expected digest is wrong (STATE-TXN-01)',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          const store = yield* GraphStore
          const result = yield* store.commit(cacheDir, {
            expected,
            expectedDigest: 'f'.repeat(64),
            graph: propose(expected, () => {}, 1),
          })
          expect(result.status).toBe('conflict')
          expect(result.graph).toEqual(expected)
        }),
    )

    it.effect(
      'conflicts with no graph when one existed at plan time and vanished (STATE-TXN-10)',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          const store = yield* GraphStore
          yield* store.purge(cacheDir)
          const result = yield* commitFrom(
            cacheDir,
            expected,
            propose(expected, () => {}, 1),
          )
          expect(result).toEqual({ graph: null, status: 'conflict' })
          expect((yield* store.read(cacheDir)).graph).toBeNull()
        }),
    )

    it.effect('commits a first graph when nothing is stored', () =>
      Effect.gen(function* () {
        const cacheDir = yield* directory()
        const store = yield* GraphStore
        expect(yield* store.read(cacheDir)).toEqual({
          digest: null,
          graph: null,
        })
        yield* seed(cacheDir, baseGraph())
        const stored = yield* store.read(cacheDir)
        expect(stored.graph).toEqual(baseGraph())
        expect(stored.digest).toBe(graphDigest(baseGraph()))
      }),
    )

    it.effect('reads a schema-4 graph as no graph (STATE-VER-03)', () =>
      Effect.gen(function* () {
        const cacheDir = yield* directory()
        yield* seed(cacheDir, baseGraph({ schema: 4 }))
        expect((yield* (yield* GraphStore).read(cacheDir)).graph).toBeNull()
      }),
    )

    it.effect(
      'purge removes the graph and a missing graph purges quietly',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const store = yield* GraphStore
          yield* store.purge(cacheDir)
          yield* seed(cacheDir, baseGraph())
          yield* store.purge(cacheDir)
          expect((yield* store.read(cacheDir)).graph).toBeNull()
        }),
    )

    it.effect(
      'serializes concurrent in-process commits and keeps every disjoint edit (STATE-TXN-18)',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* directory()
          const expected = baseGraph()
          for (let index = 0; index < 8; index += 1) {
            expected.results[`case-${index}`] = {
              file: `test/${index}.test.ts`,
              fullName: `case-${index}`,
              id: `case-${index}`,
              state: 'passed',
            }
          }
          yield* seed(cacheDir, expected)
          const results = yield* Effect.all(
            Array.from({ length: 8 }, (_, index) =>
              commitFrom(
                cacheDir,
                expected,
                propose(
                  expected,
                  (graph) => {
                    graph.results[`case-${index}`]!.fullName =
                      `updated-${index}`
                  },
                  index + 1,
                ),
              ),
            ),
            { concurrency: 'unbounded' },
          )
          expect(results.map((result) => result.status)).not.toContain(
            'conflict',
          )
          const stored = (yield* (yield* GraphStore).read(cacheDir)).graph
          expect(
            Array.from(
              { length: 8 },
              (_, index) => stored?.results[`case-${index}`]?.fullName,
            ),
          ).toEqual(Array.from({ length: 8 }, (_, index) => `updated-${index}`))
        }),
    )
  })
}

contract('graph state, live store', EngineLive, () =>
  tempDirectory('tia-state-'),
)
let counter = 0
contract(
  'graph state, memory store',
  Layer.mergeAll(GraphStoreMemory, NodeServices.layer),
  () => Effect.sync(() => `/memory/${++counter}/.tia`),
)

layer(EngineLive, { excludeTestServices: true })(
  'graph state, live store files',
  (it) => {
    it.effect(
      'rejects unsupported schemas and rebuilds safely (STATE-READ-09)',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-state-')
          for (const schema of [99, '3', 4, 5]) {
            yield* fs.writeFileString(
              join(cacheDir, 'state.json'),
              `${JSON.stringify({ ...baseGraph(), schema })}\n`,
            )
            expect((yield* (yield* GraphStore).read(cacheDir)).graph).toBeNull()
          }
        }),
    )

    it.effect(
      'recovers a lock left by a dead local writer (STATE-TXN-04)',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-state-')
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          yield* fs.makeDirectory(join(cacheDir, 'state.lock'))
          yield* fs.writeFileString(
            join(cacheDir, 'state.lock/owner.json'),
            `${JSON.stringify({
              createdAt: Date.now(),
              hostname: hostname(),
              pid: 2_147_483_647,
              token: 'dead-writer',
            })}\n`,
          )
          const proposed = propose(expected, () => {}, 1)
          const result = yield* commitFrom(cacheDir, expected, proposed, {
            lockTimeoutMs: 1_000,
          })
          expect(result.status).toBe('committed')
          expect(yield* fs.exists(join(cacheDir, 'state.lock'))).toBe(false)
          expect(
            (yield* (yield* GraphStore).read(cacheDir)).graph?.updatedAt,
          ).toBe(proposed.updatedAt)
        }),
    )

    it.effect(
      'releases its lock and preserves the graph when serialization fails (STATE-WRITE-05)',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-state-')
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          const invalid: TiaRuntimeGraph & { invalid?: bigint } =
            structuredClone(expected)
          invalid.invalid = 1n
          const failure = yield* Effect.flip(
            commitFrom(cacheDir, expected, invalid),
          )
          expect(failure._tag).toBe('TiaIo')
          expect(failure.message).toMatch(/BigInt/)
          expect((yield* (yield* GraphStore).read(cacheDir)).graph).toEqual(
            expected,
          )
          expect(yield* fs.exists(join(cacheDir, 'state.lock'))).toBe(false)
          for (const directory of [cacheDir, join(cacheDir, 'objects')]) {
            expect(
              (yield* fs.readDirectory(directory)).filter((file) =>
                file.endsWith('.tmp'),
              ),
            ).toEqual([])
          }
        }),
    )

    it.effect(
      'times out on a young lock from another host and reports a conflict (STATE-TXN-03, -05)',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-state-')
          const expected = baseGraph()
          yield* seed(cacheDir, expected)
          yield* fs.makeDirectory(join(cacheDir, 'state.lock'))
          yield* fs.writeFileString(
            join(cacheDir, 'state.lock/owner.json'),
            `${JSON.stringify({
              createdAt: Date.now(),
              hostname: 'another-host.invalid',
              pid: 1,
              token: 'remote',
            })}\n`,
          )
          const started = Date.now()
          const result = yield* commitFrom(
            cacheDir,
            expected,
            propose(expected, () => {}, 1),
            { lockTimeoutMs: 300 },
          )
          expect(result.status).toBe('conflict')
          expect(result.graph).toEqual(expected)
          expect(Date.now() - started).toBeGreaterThanOrEqual(250)
          expect(
            yield* fs.exists(join(cacheDir, 'state.lock/owner.json')),
          ).toBe(true)
        }),
    )

    it.effect(
      'reclaims a lock older than the stale threshold, even from another host or without an owner',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const expected = baseGraph()
          for (const owner of [
            JSON.stringify({
              createdAt: Date.now() - 10_000,
              hostname: 'another-host.invalid',
              pid: 1,
              token: 'remote',
            }),
            'garbage',
            null,
          ]) {
            const cacheDir = yield* tempDirectory('tia-state-')
            yield* seed(cacheDir, expected)
            yield* fs.makeDirectory(join(cacheDir, 'state.lock'))
            if (owner !== null) {
              yield* fs.writeFileString(
                join(cacheDir, 'state.lock/owner.json'),
                owner,
              )
            }
            yield* Effect.sleep(30)
            const result = yield* commitFrom(
              cacheDir,
              expected,
              propose(expected, () => {}, 1),
              { lockTimeoutMs: 2_000, staleLockMs: 20 },
            )
            expect(result.status).toBe('committed')
            expect(yield* fs.exists(join(cacheDir, 'state.lock'))).toBe(false)
          }
        }),
    )

    it.effect(
      'keeps mutual exclusion when several waiters find the same lock stale (STATE-TXN-06)',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-state-')
          const expected = baseGraph()
          for (let index = 0; index < 12; index += 1) {
            expected.results[`case-${index}`] = {
              file: `test/${index}.test.ts`,
              fullName: `case-${index}`,
              id: `case-${index}`,
              state: 'passed',
            }
          }
          yield* seed(cacheDir, expected)
          yield* fs.makeDirectory(join(cacheDir, 'state.lock'))
          yield* fs.writeFileString(
            join(cacheDir, 'state.lock/owner.json'),
            `${JSON.stringify({
              createdAt: Date.now(),
              hostname: hostname(),
              pid: 2_147_483_647,
              token: 'dead-writer',
            })}\n`,
          )
          const results = yield* Effect.all(
            Array.from({ length: 12 }, (_, index) =>
              commitFrom(
                cacheDir,
                expected,
                propose(
                  expected,
                  (graph) => {
                    graph.results[`case-${index}`]!.fullName =
                      `updated-${index}`
                  },
                  index + 1,
                ),
                { lockTimeoutMs: 20_000 },
              ),
            ),
            { concurrency: 'unbounded' },
          )
          expect(results.map((result) => result.status)).not.toContain(
            'conflict',
          )
          const stored = (yield* (yield* GraphStore).read(cacheDir)).graph
          for (let index = 0; index < 12; index += 1) {
            expect(stored?.results[`case-${index}`]?.fullName).toBe(
              `updated-${index}`,
            )
          }
          expect(yield* fs.exists(join(cacheDir, 'state.lock'))).toBe(false)
        }),
    )
  },
)
