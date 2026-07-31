import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  commitGraph,
  graphDigest,
  readGraph,
  writeGraph,
} from '../../../src/engine/state/store.js'
import { statePath } from '../../../src/engine/state/segmented.js'
import type { TiaRuntimeGraph } from '../../../src/shared/types.js'

const temporaryDirectories: string[] = []

function cacheWith(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-state-'))
  const cacheDir = join(root, '.tia')
  temporaryDirectories.push(root)
  mkdirSync(cacheDir)
  writeFileSync(statePath(cacheDir), `${JSON.stringify(value)}\n`)
  return cacheDir
}

function currentGraph(): TiaRuntimeGraph {
  return {
    baseline: { sha: 'old', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: false,
    edges: {
      'test/a.test.ts': ['src/a.ts', 'test/a.test.ts'],
      'test/b.test.ts': ['src/b.ts', 'test/b.test.ts'],
    },
    fingerprint: 'fingerprint',
    results: {
      a: {
        file: 'test/a.test.ts',
        fullName: 'a',
        id: 'a',
        state: 'passed',
      },
      b: {
        file: 'test/b.test.ts',
        fullName: 'b',
        id: 'b',
        state: 'passed',
      },
    },
    schema: 3,
    testCoverage: {},
    testEdges: {
      a: {
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
      },
      b: {
        file: 'test/b.test.ts',
        files: ['src/b.ts', 'test/b.test.ts'],
      },
    },
    updatedAt: new Date(0).toISOString(),
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('graph state', () => {
  test('rejects unsupported schemas and rebuilds safely', () => {
    expect(readGraph(cacheWith({ ...currentGraph(), schema: 99 }))).toBeNull()
    expect(readGraph(cacheWith({ ...currentGraph(), schema: '3' }))).toBeNull()
  })

  test('merges disjoint updates from processes that planned the same graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-state-'))
    temporaryDirectories.push(root)
    const cacheDir = join(root, '.tia')
    const expected = currentGraph()
    writeGraph(cacheDir, expected)

    const first = structuredClone(expected)
    first.baseline.sha = 'next'
    first.results.a!.fullName = 'a updated'
    first.updatedAt = new Date(1).toISOString()
    const second = structuredClone(expected)
    second.baseline.sha = 'next'
    second.results.b!.fullName = 'b updated'
    second.updatedAt = new Date(2).toISOString()

    expect(
      (
        await commitGraph(cacheDir, {
          expected,
          expectedDigest: graphDigest(expected),
          graph: first,
        })
      ).status,
    ).toBe('committed')
    expect(
      (
        await commitGraph(cacheDir, {
          expected,
          expectedDigest: graphDigest(expected),
          graph: second,
        })
      ).status,
    ).toBe('merged')
    expect(readGraph(cacheDir)?.results).toMatchObject({
      a: { fullName: 'a updated' },
      b: { fullName: 'b updated' },
    })
  })

  test('fails closed when concurrent writers change the same value differently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-state-'))
    temporaryDirectories.push(root)
    const cacheDir = join(root, '.tia')
    const expected = currentGraph()
    writeGraph(cacheDir, expected)

    const first = structuredClone(expected)
    first.baseline.sha = 'next'
    first.results.a!.state = 'failed'
    const second = structuredClone(expected)
    second.baseline.sha = 'next'
    second.results.a!.state = 'skipped'

    await commitGraph(cacheDir, {
      expected,
      expectedDigest: graphDigest(expected),
      graph: first,
    })
    const conflict = await commitGraph(cacheDir, {
      expected,
      expectedDigest: graphDigest(expected),
      graph: second,
    })

    expect(conflict.status).toBe('conflict')
    expect(readGraph(cacheDir)?.results.a?.state).toBe('failed')
  })

  test('recovers a lock left by a dead local writer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-state-'))
    temporaryDirectories.push(root)
    const cacheDir = join(root, '.tia')
    const expected = currentGraph()
    writeGraph(cacheDir, expected)
    mkdirSync(join(cacheDir, 'state.lock'))
    writeFileSync(
      join(cacheDir, 'state.lock/owner.json'),
      `${JSON.stringify({
        createdAt: Date.now(),
        hostname: hostname(),
        pid: 2_147_483_647,
        token: 'dead-writer',
      })}\n`,
    )
    const proposed = structuredClone(expected)
    proposed.updatedAt = new Date(1).toISOString()

    const result = await commitGraph(cacheDir, {
      expected,
      expectedDigest: graphDigest(expected),
      graph: proposed,
      lockTimeoutMs: 1_000,
    })

    expect(result.status).toBe('committed')
    expect(readGraph(cacheDir)?.updatedAt).toBe(proposed.updatedAt)
  })

  test('releases its lock and preserves the graph when serialization fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-state-'))
    temporaryDirectories.push(root)
    const cacheDir = join(root, '.tia')
    const expected = currentGraph()
    writeGraph(cacheDir, expected)
    const invalid = structuredClone(expected) as TiaRuntimeGraph & {
      invalid?: bigint
    }
    invalid.invalid = 1n

    await expect(
      commitGraph(cacheDir, {
        expected,
        expectedDigest: graphDigest(expected),
        graph: invalid,
      }),
    ).rejects.toThrow(/BigInt/)

    expect(readGraph(cacheDir)).toEqual(expected)
    expect(existsSync(join(cacheDir, 'state.lock'))).toBe(false)
    expect(
      readdirSync(cacheDir).filter((file) => file.endsWith('.tmp')),
    ).toEqual([])
  })
})
