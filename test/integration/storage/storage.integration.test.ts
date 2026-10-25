import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import { graphDigest } from '../../../src/engine/state/segments.ts'
import { baseGraph } from '../../engine/support/graphs.ts'
import { EngineLive } from '../../engine/support/layers.ts'

// The multi-process transaction test and the killed-writer failure injection.
// The Vitest-driven worktree and worker-exit cases are in
// worktrees.integration.test.ts and
// vitest-failure-injection.integration.test.ts.

const writer = fileURLToPath(
  new URL('../../fixtures/transaction-writer.mjs', import.meta.url),
)
const lockHolder = fileURLToPath(
  new URL('../../fixtures/transaction-lock-holder.mjs', import.meta.url),
)
const runtime = ManagedRuntime.make(EngineLive)
const temporaryDirectories: string[] = []

const store = <A>(
  use: (store: GraphStore['Service']) => Effect.Effect<A, unknown>,
) => runtime.runPromise(Effect.flatMap(GraphStore, use))

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-storage-'))
  temporaryDirectories.push(root)
  return root
}

function transactionGraph(size: number): TiaRuntimeGraph {
  const graph = baseGraph({
    baseline: { sha: 'old', workingTree: {} },
    edges: {},
    fingerprint: 'parallel-writers',
    results: {},
    testEdges: {},
  })
  for (let index = 0; index < size; index += 1) {
    const id = `case-${index}`
    const file = `test/${index}.test.ts`
    graph.edges[file] = [file, `src/${index}.ts`]
    graph.results[id] = { file, fullName: id, id, state: 'passed' }
    graph.testEdges[id] = { file, files: [file, `src/${index}.ts`] }
  }
  return graph
}

function runWriter(
  cacheDir: string,
  expectedPath: string,
  proposedPath: string,
): Promise<{ output: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [writer, cacheDir, expectedPath, proposedPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (value) => {
      output += String(value)
    })
    child.stderr.on('data', (value) => {
      output += String(value)
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ output, status }))
  })
}

async function crashLockHolder(cacheDir: string): Promise<void> {
  const child = spawn(process.execPath, [lockHolder, cacheDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolveReady, rejectReady) => {
    child.on('error', rejectReady)
    child.stdout.on('data', (value) => {
      if (String(value).includes('ready')) resolveReady()
    })
  })
  child.kill('SIGKILL')
  await new Promise<void>((resolveClosed) => {
    child.on('close', () => resolveClosed())
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

afterAll(() => runtime.dispose())

describe('multi-process graph transactions', () => {
  test('retains every disjoint update from simultaneous writers', async () => {
    const root = scratch()
    const cacheDir = join(root, '.tia')
    const inputDir = join(root, 'inputs')
    mkdirSync(inputDir)
    const expected = transactionGraph(8)
    const expectedPath = join(inputDir, 'expected.json')
    writeFileSync(expectedPath, JSON.stringify(expected))
    await store((s) =>
      s.commit(cacheDir, {
        expected: null,
        expectedDigest: null,
        graph: expected,
      }),
    )

    const proposals = Array.from({ length: 8 }, (_, index) => {
      const proposed = structuredClone(expected)
      proposed.baseline.sha = 'old'
      proposed.results[`case-${index}`]!.fullName = `updated-${index}`
      proposed.updatedAt = new Date(index + 1).toISOString()
      const path = join(inputDir, `proposed-${index}.json`)
      writeFileSync(path, JSON.stringify(proposed))
      return path
    })

    const results = await Promise.all(
      proposals.map((path) => runWriter(cacheDir, expectedPath, path)),
    )
    expect(
      results.map((result) => result.status),
      results.map((result) => result.output).join('\n'),
    ).toEqual(Array(8).fill(0))

    const saved = (await store((s) => s.read(cacheDir))).graph
    expect(saved).not.toBeNull()
    expect(
      Array.from(
        { length: 8 },
        (_, index) => saved?.results[`case-${index}`]?.fullName,
      ),
    ).toEqual(Array.from({ length: 8 }, (_, index) => `updated-${index}`))
    expect(existsSync(join(cacheDir, 'state.lock'))).toBe(false)
    expect(() => JSON.stringify(saved)).not.toThrow()
  })
})

describe('failure injection', () => {
  test('recovers a killed graph writer and removes its partial atomic file', async () => {
    const root = scratch()
    const cacheDir = join(root, '.tia')
    const expected = baseGraph({ updatedAt: new Date(0).toISOString() })
    const proposed = baseGraph({ updatedAt: new Date(1).toISOString() })
    await store((s) =>
      s.commit(cacheDir, {
        expected: null,
        expectedDigest: null,
        graph: expected,
      }),
    )

    await crashLockHolder(cacheDir)
    expect(existsSync(join(cacheDir, 'state.lock'))).toBe(true)
    const committed = await store((s) =>
      s.commit(cacheDir, {
        expected,
        expectedDigest: graphDigest(expected),
        graph: proposed,
        lockTimeoutMs: 1_000,
      }),
    )

    expect(committed.status).toBe('committed')
    expect((await store((s) => s.read(cacheDir))).graph).toEqual(proposed)
    expect(existsSync(join(cacheDir, 'state.lock'))).toBe(false)
    expect(
      readdirSync(cacheDir).filter((file) => file.endsWith('.tmp')),
    ).toEqual([])
  })

  test('leaves state.json byte-identical when a writer dies before its commit', async () => {
    const root = scratch()
    const cacheDir = join(root, '.tia')
    const expected = baseGraph()
    await store((s) =>
      s.commit(cacheDir, {
        expected: null,
        expectedDigest: null,
        graph: expected,
      }),
    )
    const { readFileSync } = await import('node:fs')
    const before = readFileSync(join(cacheDir, 'state.json'))
    await crashLockHolder(cacheDir)
    expect(readFileSync(join(cacheDir, 'state.json')).equals(before)).toBe(true)
    expect((await store((s) => s.read(cacheDir))).graph).toEqual(expected)
  })
})
