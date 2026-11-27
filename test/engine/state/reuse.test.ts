import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { expect, layer } from '@effect/vitest'

import type {
  CachedTestResult,
  TiaCoverageRecord,
  TiaRuntimeGraph,
  TiaTestEdge,
} from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import {
  graphSegments,
  segmentsOf,
  type SegmentReference,
} from '../../../src/engine/state/segments.ts'
import { makeStateFiles } from '../../../src/engine/state/state-files.ts'
import { updateGraph } from '../../../src/engine/state/update.ts'
import {
  runtimeGraph,
  testFileName,
  type GraphShape,
} from '../../support/bench-graph.ts'
import { EngineLive, tempDirectory } from '../support/layers.ts'

// A commit reuses the stored objects of the buckets its graph left unchanged
// instead of serializing them again. These tests hold that optimisation to the
// bytes a write without it leaves on disk.

const SHAPE: GraphShape = {
  branches: 4,
  branchesPerTest: 2,
  functions: 4,
  functionsPerTest: 2,
  sourceFiles: 12,
  sourcesPerTest: 3,
  statements: 10,
  statementsPerTest: 4,
  testFiles: 8,
  tests: 160,
}

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

/** Every file under `directory` with its bytes, by relative path. */
function snapshot(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files.set(path.slice(directory.length + 1), readFileSync(path))
  }
  return files
}

function expectSameBytes(actual: string, expected: string): void {
  const left = snapshot(actual)
  const right = snapshot(expected)
  expect([...left.keys()].sort()).toEqual([...right.keys()].sort())
  for (const [path, bytes] of left) {
    expect(bytes.equals(right.get(path)!), path).toBe(true)
  }
}

/**
 * Checks that every bucket `graph` shares with `base` serializes to the
 * object it would reuse, and returns how many buckets it shares.
 */
function reusedBuckets(graph: TiaRuntimeGraph, base: TiaRuntimeGraph): number {
  const pending = segmentsOf(graph, graphSegments(base))
  let reused = 0
  let step = pending.next()
  while (step.done !== true) {
    const { reference } = step.value.serialize()
    if (step.value.stored !== null) {
      expect(reference).toEqual<SegmentReference>(step.value.stored)
      reused += 1
    }
    step = pending.next(reference)
  }
  return reused
}

/** A run that reran some tests of a few files and maybe deleted a file. */
function randomRun(
  random: () => number,
  graph: TiaRuntimeGraph,
  root: string,
  step: number,
) {
  const files = Object.keys(graph.edges)
  const executed = files.filter(() => random() < 0.3)
  const full = executed.filter(() => random() < 0.4)
  const results = new Map<string, CachedTestResult>()
  const testEdges = new Map<string, TiaTestEdge>()
  const testCoverage = new Map<string, TiaCoverageRecord>()
  const coverageMaps: Record<string, TiaRuntimeGraph['coverageMaps'][string]> =
    {}
  for (const id of Object.keys(graph.results)) {
    const result = graph.results[id]!
    if (!executed.includes(result.file)) continue
    const fully = full.includes(result.file)
    // A fully run file can lose a test; a partly run one reruns a few.
    if (fully ? random() < 0.1 : random() < 0.7) continue
    results.set(id, { ...result, duration: step, state: 'passed' })
    const edge = graph.testEdges[id]
    const touched = edge === undefined ? [result.file] : [...edge.files]
    if (random() < 0.3) touched.push(`src/extra${step}.ts`)
    testEdges.set(id, {
      file: result.file,
      files: [...new Set(touched)].sort(),
    })
    const coverage = graph.testCoverage[id] ?? {}
    const changed: TiaCoverageRecord = {}
    for (const [source, hits] of Object.entries(coverage)) {
      // A changed source file gets a new static map; the old one may go.
      const map = random() < 0.1 ? `${hits.map}-${step}` : hits.map
      if (map !== hits.map) {
        coverageMaps[map] = graph.coverageMaps[hits.map]!
      }
      changed[source] = { ...hits, map, s: { ...hits.s, 0: step } }
    }
    testCoverage.set(id, changed)
  }
  if (files.length > 2 && random() < 0.15) {
    const doomed = files[Math.floor(random() * files.length)]!
    rmSync(join(root, doomed), { force: true })
  }
  const workingTree: Record<string, string> = {}
  for (let source = 0; source < 4; source += 1) {
    const roll = random()
    if (roll < 0.5) workingTree[`src/module${source}.ts`] = String(source)
    else if (roll < 0.75) workingTree[`src/module${source}.ts`] = `s${step}`
  }
  return {
    collectionCoverage: new Map(
      executed.map((file) => [
        file,
        structuredClone(graph.collectionCoverage[file] ?? {}),
      ]),
    ),
    collectionFiles: new Map(
      executed.map((file) => [file, [...(graph.collectionFiles[file] ?? [])]]),
    ),
    coverageMaps,
    executedFiles: executed,
    fullyExecutedFiles: full,
    header: {
      baseline: { sha: `sha-${step}`, source: 'git' as const, workingTree },
      complete: true,
      coverageComplete: true,
      fingerprint: 'fingerprint',
      partition: null,
      updatedAt: new Date(step * 1000).toISOString(),
    },
    presentFiles: [],
    results,
    root,
    testCoverage,
    testEdges,
  }
}

layer(EngineLive, { excludeTestServices: true })('bucket reuse', (it) => {
  it.effect(
    'leaves the same bytes on disk as a write that serializes every bucket',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const store = yield* GraphStore
        const files = makeStateFiles(fs)
        const root = yield* tempDirectory('tia-reuse-root-')
        for (let file = 0; file < SHAPE.testFiles; file += 1) {
          const path = join(root, testFileName(file))
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, '')
        }
        const reusing = yield* tempDirectory('tia-reuse-')
        const plain = yield* tempDirectory('tia-plain-')
        const initial = runtimeGraph(SHAPE)
        yield* store.commit(reusing, {
          expected: null,
          expectedDigest: null,
          graph: initial,
        })
        yield* files.write(plain, initial, null)
        expectSameBytes(reusing, plain)

        const random = seeded(0x5eed)
        let reused = 0
        for (let step = 1; step <= 24; step += 1) {
          const stored = yield* store.read(reusing)
          const previous = stored.graph!
          const next = yield* updateGraph({
            ...randomRun(random, previous, root, step),
            previous,
          })
          reused += reusedBuckets(next, previous)
          if (step % 8 === 0) {
            // A directory whose manifest matches but whose objects are gone,
            // as when the commit goes to another cache directory.
            const elsewhere = yield* tempDirectory('tia-elsewhere-')
            copyFileSync(
              join(reusing, 'state.json'),
              join(elsewhere, 'state.json'),
            )
            const moved = yield* store.commit(elsewhere, {
              expected: previous,
              expectedDigest: stored.digest,
              graph: next,
            })
            expect(moved.status).toBe('committed')
            expect((yield* store.read(elsewhere)).graph).toEqual(next)
          }
          const committed = yield* store.commit(reusing, {
            expected: previous,
            expectedDigest: stored.digest,
            graph: next,
          })
          expect(committed.status).toBe('committed')
          yield* files.write(plain, next, null)
          expectSameBytes(reusing, plain)
          expect((yield* store.read(reusing)).graph).toEqual(next)
        }
        // Most buckets of a small run's graph are the ones the store read.
        expect(reused).toBeGreaterThan(24 * 100)
      }),
  )

  it.effect('repairs a reused object corrupted after the read', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* GraphStore
      const cacheDir = yield* tempDirectory('tia-reuse-')
      yield* store.commit(cacheDir, {
        expected: null,
        expectedDigest: null,
        graph: runtimeGraph(SHAPE),
      })
      const stored = yield* store.read(cacheDir)
      const previous = stored.graph!
      const next: TiaRuntimeGraph = {
        ...previous,
        updatedAt: '2026-02-02T00:00:00.000Z',
      }
      const manifest = JSON.parse(
        readFileSync(join(cacheDir, 'state.json'), 'utf8'),
      ) as { segments: { results: Array<{ sha256: string }> } }
      const object = join(
        cacheDir,
        'objects',
        `${manifest.segments.results[0]!.sha256}.json`,
      )
      const original = yield* fs.readFileString(object)
      yield* fs.writeFileString(object, 'x'.repeat(original.length))
      const committed = yield* store.commit(cacheDir, {
        expected: previous,
        expectedDigest: stored.digest,
        graph: next,
      })
      expect(committed.status).toBe('committed')
      expect(yield* fs.readFileString(object)).toBe(original)
      expect((yield* store.read(cacheDir)).graph).toEqual(next)
    }),
  )
})
