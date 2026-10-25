import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaImpactGraph } from '../../src/core/protocol.ts'
import { runPromise } from '../../src/host/runtime.ts'
import {
  readAdapterGraph,
  writeAdapterGraph,
} from '../../src/runners/external.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tiacore-adapter-graph-'))
  temporary.push(path)
  return path
}

describe('adapter graph files', () => {
  test.each([
    ['a missing file', undefined],
    ['unparsable JSON', '{not json'],
    ['an invalid graph', '{"protocolVersion":1}'],
  ])('reads %s as no graph', async (_label, content) => {
    const path = join(await directory(), 'graph.json')
    if (content !== undefined) await writeFile(path, content)
    expect(await runPromise(readAdapterGraph(path))).toBeNull()
  })

  test('writes pretty JSON with a trailing newline through a temporary file', async () => {
    const path = join(await directory(), 'deep', 'graph.json')
    const graph: TiaImpactGraph = {
      complete: true,
      environmentFingerprint: 'e',
      fingerprint: 'f',
      observations: [],
      protocolVersion: 1,
      suites: [],
    }
    await runPromise(writeAdapterGraph(path, graph))
    expect(await readFile(path, 'utf8')).toBe(
      `${JSON.stringify(graph, null, 2)}\n`,
    )
    expect(await runPromise(readAdapterGraph(path))).toMatchObject({
      complete: true,
    })
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
  })

  test('leaves no temporary file when the rename fails', async () => {
    const path = await directory()
    const graph: TiaImpactGraph = {
      complete: true,
      environmentFingerprint: 'e',
      fingerprint: 'f',
      observations: [],
      protocolVersion: 1,
      suites: [],
    }
    // The target is a directory, so the rename cannot succeed.
    await expect(runPromise(writeAdapterGraph(path, graph))).rejects.toThrow(
      /./u,
    )
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
  })
})
