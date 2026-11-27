import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { expect, layer, test } from '@effect/vitest'

import type {
  CachedTestResult,
  TiaCoverageRecord,
  TiaRuntimeGraph,
  TiaTestEdge,
} from '../../../src/core/runtime.ts'
import { GRAPH_SCHEMA_VERSION } from '../../../src/core/runtime.ts'
import {
  emptyGraph,
  updateGraph,
  type GraphHeader,
} from '../../../src/engine/state/update.ts'
import { baseGraph, TEMPLATE } from '../support/graphs.ts'
import { EngineLive, tempDirectory } from '../support/layers.ts'

const header: GraphHeader = {
  baseline: { sha: 'next', workingTree: {} },
  complete: true,
  coverageComplete: false,
  fingerprint: 'next-fingerprint',
  partition: null,
  updatedAt: '2026-01-02T03:04:05.000Z',
}

function graph(): TiaRuntimeGraph {
  return baseGraph({
    baseline: { sha: 'baseline', workingTree: {} },
    collectionCoverage: { 'test/a.test.ts': {}, 'test/deleted.test.ts': {} },
    coverageComplete: true,
    edges: {
      'test/a.test.ts': ['src/old.ts', 'test/a.test.ts'],
      'test/deleted.test.ts': ['test/deleted.test.ts'],
    },
    results: {
      old: {
        file: 'test/a.test.ts',
        fullName: 'old case',
        id: 'old',
        state: 'passed',
      },
      removed: {
        file: 'test/deleted.test.ts',
        fullName: 'removed case',
        id: 'removed',
        state: 'passed',
      },
    },
    testCoverage: { old: {}, removed: {} },
    testEdges: {
      old: { file: 'test/a.test.ts', files: ['src/old.ts', 'test/a.test.ts'] },
      removed: {
        file: 'test/deleted.test.ts',
        files: ['test/deleted.test.ts'],
      },
    },
  })
}

const newCase = {
  file: 'test/a.test.ts',
  fullName: 'new case',
  id: 'new',
  state: 'passed',
} as const

const projectWith = (...files: string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* tempDirectory('tia-update-')
    for (const file of files) {
      yield* fs.makeDirectory(join(root, file, '..'), { recursive: true })
      yield* fs.writeFileString(join(root, file), 'test("a", () => {})\n')
    }
    return root
  })

// proofs/Tia/Update.lean: full_replaces, partial_keeps_collection,
// partial_keeps_observed, partial_covered, partial_replayed_keeps.
const layered = (): TiaRuntimeGraph =>
  baseGraph({
    collectionFiles: { 'test/a.test.ts': ['src/inner-build.ts'] },
    edges: {
      'test/a.test.ts': [
        'src/inner-build.ts',
        'src/inner.ts',
        'src/outer.ts',
        'test/a.test.ts',
      ],
    },
    results: {
      inner: {
        file: 'test/a.test.ts',
        fullName: 'inner',
        id: 'inner',
        state: 'passed',
      },
      outer: {
        file: 'test/a.test.ts',
        fullName: 'outer',
        id: 'outer',
        state: 'passed',
      },
    },
    testEdges: {
      inner: {
        file: 'test/a.test.ts',
        files: ['src/inner-build.ts', 'src/inner.ts', 'test/a.test.ts'],
      },
      outer: {
        file: 'test/a.test.ts',
        files: ['src/inner-build.ts', 'src/outer.ts', 'test/a.test.ts'],
      },
    },
  })
const outerOnly = {
  executedFiles: ['test/a.test.ts'],
  results: new Map([
    [
      'outer',
      {
        file: 'test/a.test.ts',
        fullName: 'outer',
        id: 'outer',
        state: 'passed' as const,
      },
    ],
  ]),
  testEdges: new Map([
    [
      'outer',
      {
        file: 'test/a.test.ts',
        files: ['src/outer.ts', 'src/setup.ts', 'test/a.test.ts'],
      },
    ],
  ]),
}

// Random graphs and runs over a few files, for the copy-on-write property. The
// last file does not exist on disk, so updates also prune.
const SCENARIO_FILES = [
  'test/a.test.ts',
  'test/b.test.ts',
  'test/c.test.ts',
  'test/gone.test.ts',
]
const SCENARIO_SOURCES = ['src/setup.ts', 'src/x.ts', 'src/y.ts', 'src/z.ts']
const SCENARIO_MAPS = ['m1', 'm2', 'm3']

/** A deterministic generator of numbers in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(random: () => number, values: readonly T[]): T =>
  values[Math.floor(random() * values.length)]!
const some = <T>(random: () => number, values: readonly T[]): T[] =>
  values.filter(() => random() < 0.5)

function randomCoverage(random: () => number): TiaCoverageRecord {
  return Object.fromEntries(
    some(random, SCENARIO_SOURCES).map((source) => [
      source,
      {
        b: random() < 0.5 ? {} : { 0: [Math.floor(random() * 3), 1] },
        f: { 0: Math.floor(random() * 3) },
        map: pick(random, SCENARIO_MAPS.slice(0, 2)),
        s: { 0: Math.floor(random() * 3), 1: 1 },
      },
    ]),
  )
}

function randomGraph(random: () => number): TiaRuntimeGraph {
  const generated = baseGraph({
    collectionCoverage: {},
    collectionFiles: {},
    coverageMaps: Object.fromEntries(
      SCENARIO_MAPS.map((map) => [map, TEMPLATE]),
    ),
    edges: {},
    results: {},
    testCoverage: {},
    testEdges: {},
  })
  for (let index = 0; index < 8; index += 1) {
    const id = `t${index}`
    const file = pick(random, SCENARIO_FILES)
    const state = pick(random, ['passed', 'failed', 'skipped'] as const)
    generated.results[id] = { file, fullName: id, id, state }
    if (random() < 0.8) {
      generated.testEdges[id] = {
        file,
        files: union(some(random, SCENARIO_SOURCES), [file]),
      }
    }
    if (random() < 0.7) generated.testCoverage[id] = randomCoverage(random)
    generated.edges[file] = union(
      generated.edges[file] ?? [file],
      generated.testEdges[id]?.files ?? [],
    )
  }
  for (const file of some(random, Object.keys(generated.edges))) {
    generated.collectionFiles[file] = some(random, SCENARIO_SOURCES)
    generated.collectionCoverage[file] = randomCoverage(random)
  }
  return generated
}

function randomRun(random: () => number, root: string) {
  const executed = some(random, SCENARIO_FILES.slice(0, -1))
  const results = new Map<string, CachedTestResult>()
  const testEdges = new Map<string, TiaTestEdge>()
  const testCoverage = new Map<string, TiaCoverageRecord>()
  for (const file of executed) {
    for (let index = 0; index < 3; index += 1) {
      if (random() < 0.4) continue
      const id = random() < 0.5 ? `t${Math.floor(random() * 8)}` : `n${index}`
      results.set(id, { file, fullName: id, id, state: 'passed' })
      testEdges.set(id, {
        file,
        files: union(some(random, SCENARIO_SOURCES), [file]),
      })
      if (random() < 0.7) testCoverage.set(id, randomCoverage(random))
    }
  }
  const observed = some(random, executed)
  return {
    ...(random() < 0.7
      ? {
          collectionCoverage: new Map(
            observed.map((file) => [file, randomCoverage(random)]),
          ),
          collectionFiles: new Map(
            observed.map((file) => [file, some(random, SCENARIO_SOURCES)]),
          ),
        }
      : {}),
    coverageMaps: { m4: TEMPLATE },
    executedFiles: executed,
    fallbackEdges: new Map(
      some(random, executed).map((file) => [file, ['src/fallback.ts', file]]),
    ),
    fullyExecutedFiles: some(random, executed),
    header,
    presentFiles: some(random, SCENARIO_FILES),
    results,
    root,
    testCoverage,
    testEdges,
  }
}

function union(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())].sort()
}

layer(EngineLive, { excludeTestServices: true })(
  'shared graph updates',
  (it) => {
    it.effect(
      'checks only the graph files the caller did not see on disk',
      () =>
        Effect.gen(function* () {
          // Neither file exists here. The one the caller says it saw is kept
          // without a check; the other is pruned.
          const root = yield* projectWith()
          const previous = graph()
          const updated = yield* updateGraph({
            executedFiles: [],
            fullyExecutedFiles: [],
            header,
            presentFiles: ['test/a.test.ts'],
            previous,
            results: new Map(),
            root,
            testEdges: new Map(),
          })
          expect(Object.keys(updated.edges)).toEqual(['test/a.test.ts'])
          expect(updated.results['removed']).toBeUndefined()
          expect(updated.results['old']).toBeDefined()
        }),
    )

    it.effect('replaces whole files and prunes deleted files atomically', () =>
      Effect.gen(function* () {
        const root = yield* projectWith('test/a.test.ts')
        const previous = graph()
        const snapshot = structuredClone(previous)

        const updated = yield* updateGraph({
          header,
          collectionCoverage: new Map([['test/a.test.ts', {}]]),
          executedFiles: ['test/a.test.ts'],
          fullyExecutedFiles: ['test/a.test.ts'],
          previous,
          results: new Map([['new', newCase]]),
          root,
          testCoverage: new Map([['new', {}]]),
          testEdges: new Map([
            [
              'new',
              {
                file: 'test/a.test.ts',
                files: ['src/new.ts', 'test/a.test.ts'],
              },
            ],
          ]),
        })

        expect(updated.results).toEqual({
          new: expect.objectContaining({ fullName: 'new case' }),
        })
        expect(updated.testEdges).toEqual({
          new: {
            file: 'test/a.test.ts',
            files: ['src/new.ts', 'test/a.test.ts'],
          },
        })
        expect(updated.testCoverage).toEqual({ new: {} })
        expect(updated.edges).toEqual({
          'test/a.test.ts': ['src/new.ts', 'test/a.test.ts'],
        })
        expect(updated.collectionCoverage).toEqual({ 'test/a.test.ts': {} })
        expect(previous).toEqual(snapshot)
      }),
    )

    it.effect(
      'keeps the collection of a partially run file and gives it to every test',
      () =>
        Effect.gen(function* () {
          const root = yield* projectWith('test/a.test.ts')
          const updated = yield* updateGraph({
            header,
            ...outerOnly,
            collectionFiles: new Map([['test/a.test.ts', ['src/setup.ts']]]),
            fullyExecutedFiles: [],
            previous: layered(),
            root,
          })
          expect(updated.collectionFiles).toEqual({
            'test/a.test.ts': ['src/inner-build.ts', 'src/setup.ts'],
          })
          expect(updated.testEdges.outer?.files).toEqual([
            'src/inner-build.ts',
            'src/outer.ts',
            'src/setup.ts',
            'test/a.test.ts',
          ])
          expect(updated.testEdges.inner?.files).toEqual([
            'src/inner-build.ts',
            'src/inner.ts',
            'src/setup.ts',
            'test/a.test.ts',
          ])
        }),
    )

    it.effect('replaces the collection of a fully run file', () =>
      Effect.gen(function* () {
        const root = yield* projectWith('test/a.test.ts')
        const updated = yield* updateGraph({
          header,
          ...outerOnly,
          collectionFiles: new Map([['test/a.test.ts', ['src/setup.ts']]]),
          fullyExecutedFiles: ['test/a.test.ts'].values(),
          previous: layered(),
          root,
        })
        expect(updated.collectionFiles).toEqual({
          'test/a.test.ts': ['src/setup.ts'],
        })
        expect(Object.keys(updated.testEdges)).toEqual(['outer'])
        expect(updated.testEdges.outer?.files).toEqual([
          'src/outer.ts',
          'src/setup.ts',
          'test/a.test.ts',
        ])
      }),
    )

    it.effect(
      'leaves collection evidence alone for runners that do not report it',
      () =>
        Effect.gen(function* () {
          const root = yield* projectWith('test/a.test.ts')
          const updated = yield* updateGraph({
            header,
            ...outerOnly,
            fullyExecutedFiles: [],
            previous: layered(),
            root,
          })
          expect(updated.collectionFiles).toEqual(layered().collectionFiles)
          expect(updated.testEdges.outer?.files).toEqual([
            'src/outer.ts',
            'src/setup.ts',
            'test/a.test.ts',
          ])
        }),
    )

    it.effect(
      'merges the collection coverage of a partial run counter by counter',
      () =>
        Effect.gen(function* () {
          const root = yield* projectWith('test/a.test.ts')
          const previous = baseGraph({
            collectionCoverage: {
              'test/a.test.ts': {
                'src/build.ts': {
                  b: { 0: [1, 0] },
                  f: { 0: 1 },
                  map: 'm',
                  s: { 0: 2 },
                },
                'src/kept.ts': { b: {}, f: {}, map: 'k', s: { 0: 1 } },
                'src/changed.ts': { b: {}, f: {}, map: 'old', s: { 0: 1 } },
              },
            },
          })
          const updated = yield* updateGraph({
            header,
            collectionCoverage: new Map([
              [
                'test/a.test.ts',
                {
                  'src/build.ts': {
                    b: { 0: [0, 3] },
                    f: { 0: 0 },
                    map: 'm',
                    s: { 0: 0, 1: 1 },
                  },
                  'src/changed.ts': { b: {}, f: {}, map: 'new', s: { 0: 0 } },
                },
              ],
            ]),
            executedFiles: ['test/a.test.ts'],
            fullyExecutedFiles: [],
            previous,
            results: new Map(),
            root,
            testEdges: new Map(),
          })
          expect(updated.collectionCoverage['test/a.test.ts']).toEqual({
            'src/build.ts': {
              b: { 0: [1, 3] },
              f: { 0: 1 },
              map: 'm',
              s: { 0: 2, 1: 1 },
            },
            'src/changed.ts': { b: {}, f: {}, map: 'new', s: { 0: 0 } },
            'src/kept.ts': { b: {}, f: {}, map: 'k', s: { 0: 1 } },
          })
        }),
    )

    it.effect('keeps the results of tests that were not rerun', () =>
      Effect.gen(function* () {
        const root = yield* projectWith(
          'test/a.test.ts',
          'test/deleted.test.ts',
        )
        const updated = yield* updateGraph({
          header,
          executedFiles: ['test/a.test.ts'],
          fullyExecutedFiles: [],
          previous: graph(),
          results: new Map([['new', newCase]]),
          root,
          testEdges: new Map([
            [
              'new',
              {
                file: 'test/a.test.ts',
                files: ['test/a.test.ts', 'src/z.ts'],
              },
            ],
          ]),
        })
        expect(Object.keys(updated.results).sort()).toEqual([
          'new',
          'old',
          'removed',
        ])
        expect(updated.edges['test/a.test.ts']).toEqual([
          'src/old.ts',
          'src/z.ts',
          'test/a.test.ts',
        ])
        expect(updated.collectionCoverage).toEqual(graph().collectionCoverage)
      }),
    )

    it.effect('falls back for edges when no test edge names the file', () =>
      Effect.gen(function* () {
        const root = yield* projectWith(
          'test/a.test.ts',
          'test/b.test.ts',
          'test/c.test.ts',
          'test/deleted.test.ts',
        )
        const fallback = yield* updateGraph({
          header,
          executedFiles: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
          fallbackEdges: new Map([
            ['test/b.test.ts', ['x.ts', 'test/b.test.ts']],
          ]),
          fullyExecutedFiles: ['test/a.test.ts'],
          previous: graph(),
          results: new Map(),
          root,
          testEdges: new Map(),
        })
        expect(fallback.edges['test/a.test.ts']).toEqual([
          'src/old.ts',
          'test/a.test.ts',
        ])
        expect(fallback.edges['test/b.test.ts']).toEqual([
          'x.ts',
          'test/b.test.ts',
        ])
        expect(fallback.edges['test/c.test.ts']).toEqual(['test/c.test.ts'])
      }),
    )

    it.effect('replaces or leaves collection coverage as supplied', () =>
      Effect.gen(function* () {
        const root = yield* projectWith(
          'test/a.test.ts',
          'test/deleted.test.ts',
        )
        const record = { 'src/a.ts': { b: {}, f: {}, map: 'm', s: { 0: 1 } } }
        const withTemplate = {
          header,
          coverageMaps: { m: TEMPLATE },
          executedFiles: ['test/a.test.ts'],
          fullyExecutedFiles: [],
          previous: graph(),
          results: new Map(),
          root,
          testEdges: new Map(),
        }
        const kept = yield* updateGraph(withTemplate)
        expect(kept.collectionCoverage).toEqual(graph().collectionCoverage)
        const replaced = yield* updateGraph({
          ...withTemplate,
          collectionCoverage: new Map([['test/a.test.ts', record]]),
        })
        expect(replaced.collectionCoverage['test/a.test.ts']).toEqual(record)
        expect(replaced.coverageMaps).toEqual({ m: TEMPLATE })
        const absent = yield* updateGraph({
          ...withTemplate,
          collectionCoverage: new Map(),
        })
        expect(absent.collectionCoverage['test/a.test.ts']).toEqual({})
      }),
    )

    it.effect(
      'prunes a missing test file with its records, and unreferenced maps',
      () =>
        Effect.gen(function* () {
          const root = yield* projectWith('test/a.test.ts')
          const previous = graph()
          previous.coverageMaps = { gone: TEMPLATE }
          previous.testCoverage.removed = {
            'src/x.ts': { b: {}, f: {}, map: 'gone', s: {} },
          }
          const updated = yield* updateGraph({
            header,
            executedFiles: [],
            fullyExecutedFiles: [],
            previous,
            results: new Map(),
            root,
            testEdges: new Map(),
          })
          expect(Object.keys(updated.edges)).toEqual(['test/a.test.ts'])
          expect(Object.keys(updated.results)).toEqual(['old'])
          expect(Object.keys(updated.testCoverage)).toEqual(['old'])
          expect(updated.collectionCoverage).toEqual({ 'test/a.test.ts': {} })
          expect(updated.coverageMaps).toEqual({})
        }),
    )

    it.effect(
      'stamps the schema and every header field, whatever the previous graph held',
      () =>
        Effect.gen(function* () {
          const root = yield* projectWith('test/a.test.ts')
          const previous = graph()
          previous.schema = 4
          previous.partition = { group: 'old', index: 0, total: 2 }
          const input = {
            executedFiles: [],
            fullyExecutedFiles: [],
            results: new Map(),
            root,
            testEdges: new Map(),
          }
          const stamped = {
            baseline: header.baseline,
            complete: header.complete,
            coverageComplete: header.coverageComplete,
            fingerprint: header.fingerprint,
            schema: GRAPH_SCHEMA_VERSION,
            updatedAt: header.updatedAt,
          }

          const updated = yield* updateGraph({ ...input, header, previous })
          expect(updated).toMatchObject(stamped)
          expect(previous.coverageComplete).toBe(true)
          expect(updated).not.toHaveProperty('partition')

          const shard = { group: 'g', index: 1, total: 3 }
          const partitioned = yield* updateGraph({
            ...input,
            header: { ...header, partition: shard },
            previous,
          })
          expect(partitioned.partition).toEqual(shard)
          expect(partitioned.partition).not.toBe(shard)

          const fresh = yield* updateGraph({ ...input, header, previous: null })
          expect(fresh).toEqual({ ...emptyGraph(), ...stamped })
        }),
    )

    it.effect(
      'shares coverage records with the caller and unchanged records with the previous graph',
      () =>
        Effect.gen(function* () {
          const root = yield* projectWith('test/a.test.ts')
          const previous = graph()
          previous.coverageMaps = { m: TEMPLATE }
          previous.testCoverage.old = {
            'src/a.ts': { b: {}, f: {}, map: 'm', s: {} },
          }
          const record = { 'src/a.ts': { b: {}, f: {}, map: 'm', s: { 0: 1 } } }
          const updated = yield* updateGraph({
            header,
            executedFiles: [],
            fullyExecutedFiles: [],
            previous,
            results: new Map(),
            root,
            testCoverage: new Map([['new', record]]),
            testEdges: new Map(),
          })
          expect(updated.testCoverage.new).toBe(record)
          expect(updated.coverageMaps.m).toBe(TEMPLATE)
          expect(updated.testCoverage.old).toBe(previous.testCoverage.old)
          expect(updated.results.old).toBe(previous.results.old)
          expect(updated.testCoverage).not.toBe(previous.testCoverage)
        }),
    )

    it.effect(
      'never changes the previous graph and matches an update of a deep copy',
      () =>
        Effect.gen(function* () {
          const root = yield* projectWith(...SCENARIO_FILES.slice(0, -1))
          const random = seeded(0x7a11)
          for (let round = 0; round < 300; round += 1) {
            const previous = randomGraph(random)
            const snapshot = structuredClone(previous)
            const input = randomRun(random, root)
            const updated = yield* updateGraph({ ...input, previous })
            const copied = yield* updateGraph({
              ...input,
              previous: structuredClone(previous),
            })
            expect(previous).toStrictEqual(snapshot)
            expect(updated).toStrictEqual(copied)
            // The next run updates this one's graph and must not change it.
            const kept = structuredClone(updated)
            yield* updateGraph({
              ...randomRun(random, root),
              previous: updated,
            })
            expect(updated).toStrictEqual(kept)
          }
        }),
    )
  },
)

test('emptyGraph is the record-mode starting point', () => {
  expect(emptyGraph()).toEqual({
    baseline: { sha: '', workingTree: {} },
    collectionCoverage: {},
    collectionFiles: {},
    complete: false,
    coverageComplete: false,
    coverageMaps: {},
    edges: {},
    fingerprint: '',
    results: {},
    schema: 6,
    testCoverage: {},
    testEdges: {},
    updatedAt: '',
  })
})
