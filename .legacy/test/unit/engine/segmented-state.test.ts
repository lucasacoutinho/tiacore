import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  commitGraph,
  graphDigest,
  readGraph,
  writeGraph,
} from '../../../src/engine/state/store.js'
import {
  stateObjectsPath,
  statePath,
  TIA_RUNTIME_STORE_BUCKETS,
  TIA_RUNTIME_STORE_VERSION,
} from '../../../src/engine/state/segmented.js'
import type { TiaRuntimeGraph } from '../../../src/shared/types.js'

const temporaryDirectories: string[] = []

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-segmented-'))
  temporaryDirectories.push(root)
  return join(root, '.tia')
}

function largeGraph(size: number): TiaRuntimeGraph {
  const graph: TiaRuntimeGraph = {
    baseline: { sha: 'large-baseline', source: 'git', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: false,
    coverageMaps: {},
    edges: {},
    fingerprint: 'large-fixture',
    results: {},
    schema: 4,
    testCoverage: {},
    testEdges: {},
    updatedAt: new Date(0).toISOString(),
  }
  for (let index = 0; index < size; index += 1) {
    const id = `case-${String(index).padStart(6, '0')}`
    const file = `test/suite-${String(index).padStart(6, '0')}.test.ts`
    const source = `src/module-${String(index).padStart(6, '0')}.ts`
    graph.edges[file] = [file, source]
    graph.results[id] = {
      file,
      fullName: `large case ${index}`,
      id,
      state: 'passed',
    }
    graph.testEdges[id] = { file, files: [file, source] }
  }
  return graph
}

function coverageGraph(tests: number): TiaRuntimeGraph {
  const graph = largeGraph(tests)
  const template = {
    b: { 0: [0, 0] },
    branchMap: {
      0: {
        loc: { end: { column: 9, line: 1 }, start: { column: 0, line: 1 } },
        locations: [],
        type: 'if',
      },
    },
    f: { 0: 0 },
    fnMap: {},
    s: { 0: 0, 1: 0 },
    statementMap: {
      0: { end: { column: 9, line: 1 }, start: { column: 0, line: 1 } },
      1: { end: { column: 9, line: 2 }, start: { column: 0, line: 2 } },
    },
  } as unknown as TiaRuntimeGraph['coverageMaps'][string]
  graph.coverageMaps = { shared: template, unused: template }
  for (const id of Object.keys(graph.testEdges)) {
    graph.testCoverage[id] = {
      'src/shared.ts': {
        b: { 0: [1, 0] },
        f: { 0: 1 },
        map: 'shared',
        s: { 1: 2 },
      },
    }
  }
  return graph
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

describe('segmented runtime state', () => {
  test('persists a large graph behind a bounded atomic manifest', () => {
    const cacheDir = directory()
    const graph = largeGraph(25_000)

    writeGraph(cacheDir, graph)

    const manifest = JSON.parse(readFileSync(statePath(cacheDir), 'utf8')) as {
      format: string
      generation: string
      segments: Record<string, unknown[]>
      version: number
    }
    expect(manifest).toMatchObject({
      format: 'tiacore-runtime-state',
      generation: expect.stringMatching(/^[a-f0-9]{64}$/),
      version: TIA_RUNTIME_STORE_VERSION,
    })
    expect(statSync(statePath(cacheDir)).size).toBeLessThan(1024 * 1024)
    expect(readdirSync(stateObjectsPath(cacheDir)).length).toBeLessThanOrEqual(
      5 * TIA_RUNTIME_STORE_BUCKETS,
    )
    expect(readGraph(cacheDir)).toEqual(graph)
  }, 20_000)

  test('reuses unchanged content-addressed buckets across commits', () => {
    const cacheDir = directory()
    const graph = largeGraph(1_000)
    writeGraph(cacheDir, graph)
    const before = new Set(readdirSync(stateObjectsPath(cacheDir)))

    graph.results['case-000000']!.state = 'failed'
    graph.updatedAt = new Date(1).toISOString()
    writeGraph(cacheDir, graph)
    const after = new Set(readdirSync(stateObjectsPath(cacheDir)))
    const reused = [...before].filter((file) => after.has(file))

    expect(reused.length / before.size).toBeGreaterThan(0.95)
    expect(after.size).toBe(before.size + 1)
    expect(readGraph(cacheDir)?.results['case-000000']?.state).toBe('failed')
  })

  test('fails closed when a referenced object is corrupted', () => {
    const cacheDir = directory()
    writeGraph(cacheDir, largeGraph(10))
    const manifest = JSON.parse(readFileSync(statePath(cacheDir), 'utf8')) as {
      segments: Record<string, Array<{ sha256: string }>>
    }
    const reference = Object.values(manifest.segments).flat()[0]
    if (reference === undefined) throw new Error('expected a segment')
    writeFileSync(
      join(stateObjectsPath(cacheDir), `${reference.sha256}.json`),
      '{"corrupt":true}\n',
    )

    expect(readGraph(cacheDir)).toBeNull()
  })

  test('stores each coverage map once and identifies graphs by generation', () => {
    const cacheDir = directory()
    const graph = coverageGraph(2_000)

    writeGraph(cacheDir, graph)

    const manifest = JSON.parse(readFileSync(statePath(cacheDir), 'utf8')) as {
      generation: string
      segments: { coverageMaps: Array<{ entries: number }> }
    }
    const stored = readGraph(cacheDir)
    expect(manifest.segments.coverageMaps).toEqual([
      expect.objectContaining({ entries: 1 }),
    ])
    expect(Object.keys(stored?.coverageMaps ?? {})).toEqual(['shared'])
    expect(stored?.testCoverage).toEqual(graph.testCoverage)
    expect(graphDigest(stored)).toBe(manifest.generation)
    expect(graphDigest(graph)).toBe(manifest.generation)
  })

  test('rejects coverage that names a missing map', () => {
    const cacheDir = directory()
    const graph = coverageGraph(3)
    graph.coverageMaps = {}

    writeGraph(cacheDir, graph)

    expect(readGraph(cacheDir)).toBeNull()
  })

  test('rebuilds instead of reading a store written by an older version', async () => {
    const cacheDir = directory()
    const graph = coverageGraph(3)
    writeGraph(cacheDir, graph)
    const manifest = JSON.parse(readFileSync(statePath(cacheDir), 'utf8')) as {
      generation: string
      metadata: unknown
      segments: unknown
      version: number
    }
    manifest.version = 1
    manifest.generation = createHash('sha256')
      .update(
        JSON.stringify({
          metadata: manifest.metadata,
          segments: manifest.segments,
        }),
      )
      .digest('hex')
    writeFileSync(statePath(cacheDir), JSON.stringify(manifest))

    expect(readGraph(cacheDir)).toBeNull()
    await expect(
      commitGraph(cacheDir, { expected: null, expectedDigest: null, graph }),
    ).resolves.toMatchObject({ status: 'committed' })
    expect(readGraph(cacheDir)?.testCoverage).toEqual(graph.testCoverage)
  })
})
