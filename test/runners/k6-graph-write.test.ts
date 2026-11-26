import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaImpactGraph } from '../../src/core/protocol.ts'
import { runPromise } from '../../src/host/runtime.ts'
import { writeAdapterGraph } from '../../src/runners/external.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tiacore-graph-write-'))
  temporary.push(path)
  return path
}

function graph(size: number): TiaImpactGraph {
  return {
    complete: true,
    environmentFingerprint: 'e',
    fingerprint: 'f'.repeat(size),
    observations: [],
    protocolVersion: 1,
    suites: [],
  }
}

// k6, Maestro and Gradle promote their graphs through writeAdapterGraph. Two
// runners of one process (two k6 lanes under Promise.all, say) share the
// default graph path.
describe('adapter graph promotion', () => {
  test('concurrent writes of one path in one process all succeed and leave one whole graph', async () => {
    const root = await directory()
    const path = join(root, 'graph.json')
    const graphs = [1, 40_000, 2, 80_000, 3, 120_000].map(graph)
    const results = await Promise.allSettled(
      graphs.map((value) => runPromise(writeAdapterGraph(path, value))),
    )
    expect(results.map((result) => result.status)).toEqual(
      graphs.map(() => 'fulfilled'),
    )
    expect(
      graphs.map((value) => `${JSON.stringify(value, null, 2)}\n`),
    ).toContain(await readFile(path, 'utf8'))
    expect(await readdir(root)).toEqual(['graph.json'])
  })

  test('a failed promotion leaves no temporary file', async () => {
    const root = await directory()
    // The target is a directory, so the rename cannot succeed.
    await expect(runPromise(writeAdapterGraph(root, graph(1)))).rejects.toThrow(
      /./u,
    )
    const parent = await readdir(join(root, '..'))
    const base = root.split(/[\\/]/u).at(-1) ?? ''
    expect(parent.filter((name) => name.startsWith(`${base}.`))).toEqual([])
  })
})
