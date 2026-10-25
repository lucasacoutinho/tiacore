import { createHash } from 'node:crypto'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { expect, layer } from '@effect/vitest'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import {
  bucketFor,
  graphDigest,
  TIA_RUNTIME_STORE_BUCKETS,
  TIA_RUNTIME_STORE_VERSION,
} from '../../../src/engine/state/segments.ts'
import { baseGraph, coverageGraph, largeGraph } from '../support/graphs.ts'
import { EngineLive, tempDirectory } from '../support/layers.ts'

type Domain =
  | 'collectionCoverage'
  | 'coverageMaps'
  | 'edges'
  | 'results'
  | 'testCoverage'
  | 'testEdges'
  | 'workingTree'
interface Reference {
  bucket: number
  bytes: number
  entries: number
  sha256: string
}
interface Manifest {
  format: string
  generation: string
  metadata: Record<string, unknown>
  segments: Record<Domain, Reference[]>
  version: number
}

const write = (cacheDir: string, graph: TiaRuntimeGraph) =>
  Effect.gen(function* () {
    const store = yield* GraphStore
    return yield* store.commit(cacheDir, {
      expected: null,
      expectedDigest: null,
      graph,
    })
  })

const readGraph = (cacheDir: string) =>
  Effect.map(
    Effect.flatMap(GraphStore, (store) => store.read(cacheDir)),
    (stored) => stored.graph,
  )

const manifestOf = (cacheDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return JSON.parse(
      yield* fs.readFileString(join(cacheDir, 'state.json')),
    ) as Manifest
  })

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Rewrites the manifest with a valid regenerated generation. */
const rewriteManifest = (
  cacheDir: string,
  edit: (manifest: Manifest) => void,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifest = yield* manifestOf(cacheDir)
    edit(manifest)
    manifest.generation = sha(
      JSON.stringify({
        metadata: manifest.metadata,
        segments: manifest.segments,
      }),
    )
    yield* fs.writeFileString(
      join(cacheDir, 'state.json'),
      JSON.stringify(manifest),
    )
  })

layer(EngineLive, { excludeTestServices: true })(
  'segmented runtime state',
  (it) => {
    it.effect(
      'persists a large graph behind a bounded atomic manifest',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = largeGraph(25_000)
          yield* write(cacheDir, graph)
          const manifest = yield* manifestOf(cacheDir)
          expect(manifest).toMatchObject({
            format: 'tiacore-runtime-state',
            generation: expect.stringMatching(/^[a-f0-9]{64}$/u),
            version: TIA_RUNTIME_STORE_VERSION,
          })
          expect(
            Number((yield* fs.stat(join(cacheDir, 'state.json'))).size),
          ).toBeLessThan(1024 * 1024)
          expect(
            (yield* fs.readDirectory(join(cacheDir, 'objects'))).length,
          ).toBeLessThanOrEqual(7 * TIA_RUNTIME_STORE_BUCKETS)
          expect(yield* readGraph(cacheDir)).toEqual(graph)
        }),
      60_000,
    )

    it.effect(
      'keeps a huge dirty working tree out of the manifest',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = baseGraph()
          for (let index = 0; index < 60_000; index += 1) {
            graph.baseline.workingTree[
              `generated/directory-${index % 97}/file-${index}.ts`
            ] = sha(String(index))
          }
          const result = yield* write(cacheDir, graph)
          expect(result.status).toBe('committed')
          expect(
            Number((yield* fs.stat(join(cacheDir, 'state.json'))).size),
          ).toBeLessThan(100 * 1024)
          const manifest = yield* manifestOf(cacheDir)
          expect(manifest.metadata.baseline).toEqual({ sha: 'old' })
          expect(manifest.segments.workingTree.length).toBeGreaterThan(1)
          expect(yield* readGraph(cacheDir)).toEqual(graph)
        }),
      60_000,
    )

    it.effect(
      'lays out metadata, seven-plus-one domains and sorted buckets',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-seg-')
          const empty = baseGraph({
            edges: {},
            results: {},
            testEdges: {},
            baseline: { sha: 'x', source: 'git', workingTree: {} },
          })
          yield* write(cacheDir, empty)
          expect(Object.keys(yield* manifestOf(cacheDir))).toEqual([
            'format',
            'generation',
            'metadata',
            'segments',
            'version',
          ])
          const manifest = yield* manifestOf(cacheDir)
          expect(Object.keys(manifest.segments)).toEqual([
            'collectionCoverage',
            'collectionFiles',
            'coverageMaps',
            'edges',
            'results',
            'testCoverage',
            'testEdges',
            'workingTree',
          ])
          expect(Object.values(manifest.segments).flat()).toEqual([])
          expect(yield* fs.readDirectory(join(cacheDir, 'objects'))).toEqual([])
          expect(Object.keys(manifest.metadata)).toEqual(
            Object.keys(manifest.metadata).sort(),
          )
          expect(manifest.metadata.baseline).toEqual({
            sha: 'x',
            source: 'git',
          })

          const filledDir = yield* tempDirectory('tia-seg-')
          yield* write(filledDir, largeGraph(500))
          const filled = yield* manifestOf(filledDir)
          for (const references of Object.values(filled.segments)) {
            const buckets = references.map((reference) => reference.bucket)
            expect(buckets).toEqual([...buckets].sort((a, b) => a - b))
          }
          const text = yield* fs.readFileString(
            join(
              filledDir,
              'objects',
              `${filled.segments.results[0]!.sha256}.json`,
            ),
          )
          expect(text.endsWith('}\n')).toBe(true)
          expect(Object.keys(JSON.parse(text))).toEqual([
            'bucket',
            'domain',
            'records',
            'version',
          ])
          expect(sha(text)).toBe(filled.segments.results[0]!.sha256)
        }),
    )

    it.effect('assigns buckets by sha256 of the key modulo 64', () =>
      Effect.sync(() => {
        expect(TIA_RUNTIME_STORE_BUCKETS).toBe(64)
        for (const key of ['a', 'case-000001', 'test/a.test.ts', 'é', '']) {
          expect(bucketFor(key)).toBe(
            createHash('sha256').update(key).digest()[0]! % 64,
          )
        }
      }),
    )

    it.effect('reuses unchanged content-addressed buckets across commits', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-seg-')
        const graph = largeGraph(1_000)
        yield* write(cacheDir, graph)
        const before = new Set(
          yield* fs.readDirectory(join(cacheDir, 'objects')),
        )
        const store = yield* GraphStore
        const stored = yield* store.read(cacheDir)

        const next = structuredClone(graph)
        next.results['case-000000']!.state = 'failed'
        next.updatedAt = new Date(1).toISOString()
        yield* store.commit(cacheDir, {
          expected: stored.graph,
          expectedDigest: stored.digest,
          graph: next,
        })
        const after = new Set(
          yield* fs.readDirectory(join(cacheDir, 'objects')),
        )
        const reused = [...before].filter((file) => after.has(file))
        expect(reused.length / before.size).toBeGreaterThan(0.95)
        expect(after.size).toBe(before.size + 1)
        expect(
          (yield* readGraph(cacheDir))?.results['case-000000']?.state,
        ).toBe('failed')
      }),
    )

    it.effect('writes nothing new for a baseline-only change', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-seg-')
        const graph = largeGraph(200)
        yield* write(cacheDir, graph)
        const before = yield* fs.readDirectory(join(cacheDir, 'objects'))
        const store = yield* GraphStore
        const stored = yield* store.read(cacheDir)
        yield* store.commit(cacheDir, {
          expected: stored.graph,
          expectedDigest: stored.digest,
          graph: { ...graph, baseline: { ...graph.baseline, sha: 'moved' } },
        })
        expect(yield* fs.readDirectory(join(cacheDir, 'objects'))).toEqual(
          before,
        )
      }),
    )

    it.effect('replaces a corrupt object of the same name', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-seg-')
        const graph = largeGraph(20)
        yield* write(cacheDir, graph)
        const reference = (yield* manifestOf(cacheDir)).segments.results[0]!
        const object = join(cacheDir, 'objects', `${reference.sha256}.json`)
        const original = yield* fs.readFileString(object)
        yield* fs.writeFileString(object, 'x'.repeat(original.length))
        expect(yield* readGraph(cacheDir)).toBeNull()
        yield* write(cacheDir, graph)
        expect(yield* fs.readFileString(object)).toBe(original)
        expect(yield* readGraph(cacheDir)).toEqual(graph)
      }),
    )

    it.effect('fails closed when a referenced object is corrupted', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-seg-')
        yield* write(cacheDir, largeGraph(10))
        const reference = Object.values(
          (yield* manifestOf(cacheDir)).segments,
        ).flat()[0]!
        yield* fs.writeFileString(
          join(cacheDir, 'objects', `${reference.sha256}.json`),
          '{"corrupt":true}\n',
        )
        expect(yield* readGraph(cacheDir)).toBeNull()
      }),
    )

    it.effect(
      'fails closed when an object is missing, truncated or mismatched',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const graph = largeGraph(10)
          const cases: Array<
            (
              object: string,
              text: string,
            ) => Effect.Effect<void, unknown, FileSystem.FileSystem>
          > = [
            (object) => fs.remove(object),
            (object, text) => fs.writeFileString(object, text.slice(0, -5)),
            (object, text) =>
              fs.writeFileString(
                object,
                text.replace('"bucket":', '"bucket" :'),
              ),
          ]
          for (const damage of cases) {
            const cacheDir = yield* tempDirectory('tia-seg-')
            yield* write(cacheDir, graph)
            const reference = (yield* manifestOf(cacheDir)).segments.edges[0]!
            const object = join(cacheDir, 'objects', `${reference.sha256}.json`)
            yield* damage(object, yield* fs.readFileString(object))
            expect(yield* readGraph(cacheDir)).toBeNull()
          }
        }),
    )

    it.effect(
      'rejects a record that hashes to another bucket or repeats across buckets',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-seg-')
          yield* write(cacheDir, largeGraph(40))
          const manifest = yield* manifestOf(cacheDir)
          const [first, second] = manifest.segments.edges
          const object = (reference: { sha256: string }) =>
            join(cacheDir, 'objects', `${reference.sha256}.json`)
          const stolen = JSON.parse(
            yield* fs.readFileString(object(first!)),
          ) as {
            records: Record<string, unknown>
          }
          const victim = JSON.parse(
            yield* fs.readFileString(object(second!)),
          ) as {
            records: Record<string, unknown>
            bucket: number
            domain: string
            version: number
          }
          Object.assign(victim.records, stolen.records)
          const body = `${JSON.stringify(victim)}\n`
          yield* fs.writeFileString(
            join(cacheDir, 'objects', `${sha(body)}.json`),
            body,
          )
          yield* rewriteManifest(cacheDir, (edited) => {
            edited.segments.edges[1] = {
              bucket: second!.bucket,
              bytes: Buffer.byteLength(body),
              entries: Object.keys(victim.records).length,
              sha256: sha(body),
            }
          })
          expect(yield* readGraph(cacheDir)).toBeNull()
        }),
    )

    it.effect('rejects tampered, retyped and malformed manifests', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const graph = largeGraph(30)
        const damage: Array<(manifest: Manifest) => void> = [
          (m) => {
            m.version = 2
          },
          (m) => {
            m.format = 'other'
          },
          (m) => {
            m.segments.edges[0]!.bucket = 64
          },
          (m) => {
            m.segments.edges[0]!.bucket = -1
          },
          (m) => {
            m.segments.edges[0]!.bytes = 0
          },
          (m) => {
            m.segments.edges[0]!.bytes = 20 * 1024 * 1024 + 1
          },
          (m) => {
            m.segments.edges[0]!.entries = 0
          },
          (m) => {
            m.segments.edges[0]!.sha256 = 'ABC'
          },
          (m) => {
            m.segments.edges.push({ ...m.segments.edges[0]! })
          },
          (m) => {
            delete (m.segments as Record<string, unknown>).workingTree
          },
          (m) => {
            m.segments.results = {} as never
          },
        ]
        for (const edit of damage) {
          const cacheDir = yield* tempDirectory('tia-seg-')
          yield* write(cacheDir, graph)
          yield* rewriteManifest(cacheDir, edit)
          expect(yield* readGraph(cacheDir)).toBeNull()
        }
        // A hand edit that leaves the generation stale is rejected too.
        const cacheDir = yield* tempDirectory('tia-seg-')
        yield* write(cacheDir, graph)
        const manifest = yield* manifestOf(cacheDir)
        manifest.metadata.fingerprint = 'tampered'
        yield* fs.writeFileString(
          join(cacheDir, 'state.json'),
          JSON.stringify(manifest),
        )
        expect(yield* readGraph(cacheDir)).toBeNull()
      }),
    )

    it.effect('reads damaged state.json as no graph, never an error', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-seg-')
        expect(yield* readGraph(cacheDir)).toBeNull()
        for (const body of [
          '',
          '{"schema":3',
          '[]',
          'null',
          'x'.repeat(1024 * 1024 + 1),
        ]) {
          yield* fs.writeFileString(join(cacheDir, 'state.json'), body)
          expect(yield* readGraph(cacheDir)).toBeNull()
        }
        yield* fs.remove(join(cacheDir, 'state.json'))
        yield* fs.makeDirectory(join(cacheDir, 'state.json'))
        expect(yield* readGraph(cacheDir)).toBeNull()
      }),
    )

    it.effect(
      'stores each coverage map once and identifies graphs by generation',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = coverageGraph(2_000)
          yield* write(cacheDir, graph)
          const manifest = yield* manifestOf(cacheDir)
          const stored = yield* readGraph(cacheDir)
          expect(manifest.segments.coverageMaps).toEqual([
            expect.objectContaining({ entries: 1 }),
          ])
          expect(Object.keys(stored?.coverageMaps ?? {})).toEqual(['shared'])
          expect(stored?.testCoverage).toEqual(graph.testCoverage)
          expect(graphDigest(stored)).toBe(manifest.generation)
          expect(graphDigest(graph)).toBe(manifest.generation)
        }),
    )

    it.effect('rejects coverage that names a missing map', () =>
      Effect.gen(function* () {
        const cacheDir = yield* tempDirectory('tia-seg-')
        const graph = coverageGraph(3)
        graph.coverageMaps = {}
        yield* write(cacheDir, graph)
        expect(yield* readGraph(cacheDir)).toBeNull()
      }),
    )

    it.effect('rejects malformed counters, maps and partitions', () =>
      Effect.gen(function* () {
        const bad: Array<(graph: TiaRuntimeGraph) => void> = [
          (g) => {
            g.testCoverage['case-000000']!['src/shared.ts']!.s = { 1: 1.5 }
          },
          (g) => {
            g.coverageMaps.shared!.s = { 0: Number.MAX_SAFE_INTEGER + 2 }
          },
          (g) => {
            g.results['case-000000']!.state = 'weird' as never
          },
          (g) => {
            g.partition = { index: 0, total: 2 }
          },
          (g) => {
            g.partition = { index: 3, total: 2 }
          },
          (g) => {
            g.partition = { index: 1.5, total: 2 }
          },
          (g) => {
            g.baseline.source = 'svn' as never
          },
          (g) => {
            g.edges['x'] = [1 as never]
          },
        ]
        for (const damage of bad) {
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = coverageGraph(3)
          damage(graph)
          yield* write(cacheDir, graph)
          expect(yield* readGraph(cacheDir)).toBeNull()
        }
        const cacheDir = yield* tempDirectory('tia-seg-')
        const good = coverageGraph(3)
        good.partition = { group: 'g', index: 2, total: 2 }
        delete good.coverageMaps.unused
        yield* write(cacheDir, good)
        expect(yield* readGraph(cacheDir)).toEqual(good)
      }),
    )

    it.effect(
      'rebuilds instead of reading a store written by an older version',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = coverageGraph(3)
          yield* write(cacheDir, graph)
          yield* rewriteManifest(cacheDir, (manifest) => {
            manifest.version = 3
          })
          expect(yield* readGraph(cacheDir)).toBeNull()
          const store = yield* GraphStore
          const result = yield* store.commit(cacheDir, {
            expected: null,
            expectedDigest: null,
            graph,
          })
          expect(result.status).toBe('committed')
          expect((yield* readGraph(cacheDir))?.testCoverage).toEqual(
            graph.testCoverage,
          )
          expect(TIA_RUNTIME_STORE_VERSION).toBe(4)
        }),
    )

    it.effect(
      'orders records by code unit whatever their insertion order',
      () =>
        Effect.gen(function* () {
          const keys = ['a', 'B', '_', 'é', 'Z', '-', 'a0', 'ä', 'a b', 'A']
          const forward = baseGraph({ results: {}, edges: {}, testEdges: {} })
          for (const key of keys) {
            forward.results[key] = {
              file: 'f',
              fullName: key,
              id: key,
              state: 'passed',
            }
          }
          const backward = baseGraph({ results: {}, edges: {}, testEdges: {} })
          for (const key of [...keys].reverse()) {
            backward.results[key] = {
              file: 'f',
              fullName: key,
              id: key,
              state: 'passed',
            }
          }
          expect(graphDigest(forward)).toBe(graphDigest(backward))
          const cacheDir = yield* tempDirectory('tia-seg-')
          yield* write(cacheDir, backward)
          const stored = yield* readGraph(cacheDir)
          expect(Object.keys(stored?.results ?? {})).toEqual(
            Object.keys(stored?.results ?? {}).sort(),
          )
          // Metadata key order is canonical too.
          const shuffled = {
            ...baseGraph(),
            baseline: { workingTree: {}, sha: 'old' },
          }
          expect(graphDigest(shuffled)).toBe(graphDigest(baseGraph()))
        }),
    )

    it.effect(
      'refuses a segment over the storage limit and keeps the previous state',
      () =>
        Effect.gen(function* () {
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = baseGraph()
          yield* write(cacheDir, graph)
          const big = structuredClone(graph)
          big.results.a!.fullName = 'x'.repeat(21 * 1024 * 1024)
          const store = yield* GraphStore
          const stored = yield* store.read(cacheDir)
          const failure = yield* Effect.flip(
            store.commit(cacheDir, {
              expected: stored.graph,
              expectedDigest: stored.digest,
              graph: big,
            }),
          )
          expect(failure.message).toMatch(
            /TIA runtime results segment \d+ exceeds the storage limit/u,
          )
          expect(yield* readGraph(cacheDir)).toEqual(graph)
        }),
      60_000,
    )

    it.effect('refuses a manifest over 1 MiB before the rename', () =>
      Effect.gen(function* () {
        const cacheDir = yield* tempDirectory('tia-seg-')
        const graph = baseGraph()
        yield* write(cacheDir, graph)
        const bloated: TiaRuntimeGraph & { notes?: string } =
          structuredClone(graph)
        bloated.notes = 'n'.repeat(1024 * 1024)
        const store = yield* GraphStore
        const stored = yield* store.read(cacheDir)
        const failure = yield* Effect.flip(
          store.commit(cacheDir, {
            expected: stored.graph,
            expectedDigest: stored.digest,
            graph: bloated,
          }),
        )
        expect(failure.message).toBe(
          'TIA runtime state manifest exceeds the storage limit',
        )
        expect(yield* readGraph(cacheDir)).toEqual(graph)
      }),
    )

    it.effect('writes only the maps coverage records name', () =>
      Effect.gen(function* () {
        const cacheDir = yield* tempDirectory('tia-seg-')
        yield* write(cacheDir, coverageGraph(5))
        expect(
          Object.keys((yield* readGraph(cacheDir))?.coverageMaps ?? {}),
        ).toEqual(['shared'])
      }),
    )

    it.effect(
      'collects unreferenced objects older than 24 h only',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = largeGraph(300)
          yield* write(cacheDir, graph)
          const objects = join(cacheDir, 'objects')
          const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
          const names = yield* fs.readDirectory(objects)
          for (const name of names)
            yield* fs.utimes(join(objects, name), old, old)
          const orphanOld = `${'a'.repeat(64)}.json`
          const orphanYoung = `${'b'.repeat(64)}.json`
          const unrelated = 'notes.json'
          for (const name of [orphanOld, orphanYoung, unrelated]) {
            yield* fs.writeFileString(join(objects, name), '{}')
          }
          yield* fs.utimes(join(objects, orphanOld), old, old)
          yield* fs.utimes(join(objects, unrelated), old, old)

          const next = structuredClone(graph)
          next.results['case-000000']!.state = 'failed'
          const store = yield* GraphStore
          const stored = yield* store.read(cacheDir)
          yield* store.commit(cacheDir, {
            expected: stored.graph,
            expectedDigest: stored.digest,
            graph: next,
          })
          const remaining = new Set(yield* fs.readDirectory(objects))
          expect(remaining.has(orphanOld)).toBe(false)
          expect(remaining.has(orphanYoung)).toBe(true)
          expect(remaining.has(unrelated)).toBe(true)
          // Reused objects were touched, so the superseded bucket survives a day
          // after its last reference rather than being deleted at once.
          const current = new Set(
            Object.values((yield* manifestOf(cacheDir)).segments)
              .flat()
              .map((r) => `${r.sha256}.json`),
          )
          for (const name of current) {
            const info = yield* fs.stat(join(objects, name))
            expect(
              Date.now() -
                info.mtime.pipe((m) =>
                  m._tag === 'Some' ? m.value.getTime() : 0,
                ),
            ).toBeLessThan(60_000)
          }
          expect(yield* readGraph(cacheDir)).toEqual(next)
        }),
      60_000,
    )

    it.effect(
      'removes abandoned temporary files at the start of a commit',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-seg-')
          const graph = baseGraph()
          yield* write(cacheDir, graph)
          const leftovers = [
            join(
              cacheDir,
              'state.json.123.00000000-0000-4000-8000-000000000000.tmp',
            ),
            join(
              cacheDir,
              'objects',
              `${'c'.repeat(64)}.json.9.00000000-0000-4000-8000-000000000000.tmp`,
            ),
          ]
          for (const file of leftovers)
            yield* fs.writeFileString(file, '{"incomplete":')
          yield* fs.writeFileString(join(cacheDir, 'keep.tmp'), 'not ours')
          const store = yield* GraphStore
          const stored = yield* store.read(cacheDir)
          yield* store.commit(cacheDir, {
            expected: stored.graph,
            expectedDigest: stored.digest,
            graph: { ...graph, updatedAt: 'later' },
          })
          for (const file of leftovers)
            expect(yield* fs.exists(file)).toBe(false)
          expect(yield* fs.exists(join(cacheDir, 'keep.tmp'))).toBe(true)
        }),
    )

    it.effect('purge removes only state.json', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-seg-')
        yield* write(cacheDir, baseGraph())
        yield* fs.makeDirectory(join(cacheDir, 'fragments'))
        const store = yield* GraphStore
        yield* store.purge(cacheDir)
        expect(yield* fs.exists(join(cacheDir, 'state.json'))).toBe(false)
        expect(
          (yield* fs.readDirectory(join(cacheDir, 'objects'))).length,
        ).toBeGreaterThan(0)
        expect(yield* fs.exists(join(cacheDir, 'fragments'))).toBe(true)
      }),
    )

    it.effect('a copied store directory stays valid', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-seg-')
        const graph = coverageGraph(20)
        delete graph.coverageMaps.unused
        yield* write(cacheDir, graph)
        const copy = yield* tempDirectory('tia-seg-copy-')
        yield* fs.copy(cacheDir, join(copy, 'moved'))
        expect(yield* readGraph(join(copy, 'moved'))).toEqual(graph)
      }),
    )
  },
)
