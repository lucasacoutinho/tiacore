import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
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
    edges: {},
    fingerprint: 'large-fixture',
    results: {},
    schema: 3,
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

    const manifest = JSON.parse(
      readFileSync(statePath(cacheDir), 'utf8'),
    ) as {
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
    const manifest = JSON.parse(
      readFileSync(statePath(cacheDir), 'utf8'),
    ) as {
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
})
