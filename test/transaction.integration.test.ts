import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { readGraph, writeGraph } from '../src/graph/state.js'
import type { TiaGraph } from '../src/shared/types.js'

const temporaryDirectories: string[] = []
const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const writer = fileURLToPath(
  new URL('./fixtures/transaction-writer.mjs', import.meta.url),
)
const stateModule = join(packageRoot, 'dist/graph/state.js')

function graph(size: number): TiaGraph {
  const value: TiaGraph = {
    baseline: { sha: 'old', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: false,
    edges: {},
    fingerprint: 'parallel-writers',
    results: {},
    schema: 3,
    testCoverage: {},
    testEdges: {},
    updatedAt: new Date(0).toISOString(),
  }

  for (let index = 0; index < size; index += 1) {
    const id = `case-${index}`
    const file = `test/${index}.test.ts`
    value.edges[file] = [file, `src/${index}.ts`]
    value.results[id] = {
      file,
      fullName: id,
      id,
      state: 'passed',
    }
    value.testEdges[id] = {
      file,
      files: [file, `src/${index}.ts`],
    }
  }
  return value
}

function runWriter(
  cacheDir: string,
  expectedPath: string,
  proposedPath: string,
): Promise<{ output: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [writer, stateModule, cacheDir, expectedPath, proposedPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('multi-process graph transactions', () => {
  test('retains every disjoint update from simultaneous writers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiajs-transactions-'))
    temporaryDirectories.push(root)
    const cacheDir = join(root, '.tia')
    const inputDir = join(root, 'inputs')
    mkdirSync(inputDir)
    const expected = graph(8)
    const expectedPath = join(inputDir, 'expected.json')
    writeFileSync(expectedPath, JSON.stringify(expected))
    writeGraph(cacheDir, expected)

    const proposals = Array.from({ length: 8 }, (_, index) => {
      const proposed = structuredClone(expected)
      proposed.baseline.sha = 'next'
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

    const saved = readGraph(cacheDir)
    expect(saved).not.toBeNull()
    expect(
      Array.from({ length: 8 }, (_, index) =>
        saved?.results[`case-${index}`]?.fullName,
      ),
    ).toEqual(
      Array.from({ length: 8 }, (_, index) => `updated-${index}`),
    )
    expect(() => JSON.stringify(saved)).not.toThrow()
  })
})
