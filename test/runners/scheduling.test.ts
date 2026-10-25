import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'

import type {
  TiaImpactGraph,
  TiaSuiteDescriptor,
} from '../../src/core/protocol.ts'
import {
  executeSuites,
  groupBy,
  normalizedConcurrency,
  parallelMap,
  readAdapterGraph,
  writeAdapterGraph,
} from '../../src/engine/scheduling.ts'
import { runPromise } from '../../src/host/runtime.ts'
import { legacy } from '../support/legacy.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  )
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tiacore-scheduling-'))
  temporary.push(path)
  return path
}

function suite(id: string, locks: string[] = []): TiaSuiteDescriptor {
  return {
    adapter: 'fake',
    file: `${id}.js`,
    id,
    project: 'p',
    ...(locks.length === 0 ? {} : { resourceLocks: locks }),
  }
}

/** A child that logs its start and end, sleeps, then exits with a chosen code. */
const script = `
const { appendFileSync } = require('node:fs')
const [log, id, code, sleep] = process.argv.slice(1)
appendFileSync(log, 'start ' + id + '\\n')
setTimeout(() => {
  appendFileSync(log, 'end ' + id + '\\n')
  process.exit(Number(code))
}, Number(sleep))
`

function run(
  log: string,
  suites: TiaSuiteDescriptor[],
  maxConcurrency: number,
  codes: Record<string, number> = {},
  sleep = 150,
) {
  return runPromise(
    executeSuites({
      argumentsFor: (item) => [
        '-e',
        script,
        log,
        item.id,
        String(codes[item.id] ?? 0),
        String(sleep),
      ],
      command: process.execPath,
      cwd: tmpdir(),
      maxConcurrency,
      suites,
    }),
  )
}

async function events(log: string): Promise<string[]> {
  return (await readFile(log, 'utf8')).trim().split('\n')
}

describe('executeSuites', () => {
  test.each([0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects maxConcurrency %s before spawning anything',
    async (value) => {
      const log = join(await directory(), 'log')
      await expect(run(log, [suite('a')], value)).rejects.toThrow(
        'TIA adapter maxConcurrency must be a positive integer',
      )
      expect(existsSync(log)).toBe(false)
    },
  )

  test('rejects an invalid maxConcurrency even without suites', async () => {
    await expect(run('unused', [], 0)).rejects.toThrow(
      'maxConcurrency must be a positive integer',
    )
  })

  test('serializes suites sharing a resource lock and overlaps the rest', async () => {
    const log = join(await directory(), 'log')
    await run(
      log,
      [suite('a', ['device']), suite('b', ['device']), suite('c')],
      3,
    )
    const seen = await events(log)
    expect(seen.indexOf('end a')).toBeLessThan(seen.indexOf('start b'))
    expect(seen.indexOf('start c')).toBeLessThan(seen.indexOf('end a'))
  })

  test('lets a later free suite overtake a lock-blocked one', async () => {
    const log = join(await directory(), 'log')
    await run(log, [suite('a', ['x']), suite('b', ['x']), suite('c', ['y'])], 2)
    const seen = await events(log)
    expect(seen.indexOf('start c')).toBeLessThan(seen.indexOf('start b'))
  })

  test('does not deadlock suites that hold the same locks in a different order', async () => {
    const log = join(await directory(), 'log')
    const executions = await run(
      log,
      [suite('a', ['x', 'y']), suite('b', ['y', 'x'])],
      2,
      {},
      30,
    )
    expect(executions.map((item) => item.suiteId)).toEqual(['a', 'b'])
  })

  test('never runs more suites at once than maxConcurrency', async () => {
    const log = join(await directory(), 'log')
    await run(log, [suite('a'), suite('b'), suite('c'), suite('d')], 2)
    let running = 0
    let peak = 0
    for (const line of await events(log)) {
      running += line.startsWith('start') ? 1 : -1
      peak = Math.max(peak, running)
    }
    expect(peak).toBe(2)
  })

  test('runs every suite after a failure and sorts executions by suite id', async () => {
    const log = join(await directory(), 'log')
    const executions = await run(
      log,
      [suite('c'), suite('b'), suite('a')],
      1,
      { a: 3, b: 7 },
      10,
    )
    expect(executions).toEqual([
      { status: 3, suiteId: 'a' },
      { status: 7, suiteId: 'b' },
      { status: 0, suiteId: 'c' },
    ])
  })

  test('reports 128 for a child ended by a signal', async () => {
    const executions = await runPromise(
      executeSuites({
        argumentsFor: () => ['-e', "process.kill(process.pid, 'SIGKILL')"],
        command: process.execPath,
        cwd: tmpdir(),
        maxConcurrency: 1,
        suites: [suite('a')],
      }),
    )
    expect(executions).toEqual([{ status: 128, suiteId: 'a' }])
  })

  test('rejects with the spawn error for a missing command', async () => {
    await expect(
      runPromise(
        executeSuites({
          argumentsFor: () => [],
          command: 'tiacore-no-such-binary',
          cwd: tmpdir(),
          maxConcurrency: 1,
          suites: [suite('a')],
        }),
      ),
    ).rejects.toThrow(/ENOENT/u)
  })

  test('passes the environment on top of the parent environment', async () => {
    const path = await directory()
    const log = join(path, 'log')
    await runPromise(
      executeSuites({
        argumentsFor: () => [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(log)}, process.env.TIA_FAKE + ':' + (process.env.PATH ? 'path' : 'nopath'))`,
        ],
        command: process.execPath,
        cwd: path,
        environment: { TIA_FAKE: 'yes' },
        maxConcurrency: 1,
        suites: [suite('a')],
      }),
    )
    expect(await readFile(log, 'utf8')).toBe('yes:path')
  })
})

describe('executeSuites cleanup', () => {
  test('stops running children when the run is interrupted', async () => {
    const path = await directory()
    const pidFile = join(path, 'pid')
    const sleeper = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`
    await runPromise(
      executeSuites({
        argumentsFor: () => ['-e', sleeper],
        command: process.execPath,
        cwd: path,
        maxConcurrency: 1,
        suites: [suite('a')],
      }).pipe(Effect.timeout('700 millis'), Effect.ignore),
    )
    const pid = Number(await readFile(pidFile, 'utf8'))
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const deadline = Date.now() + 5000
    while (alive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(alive()).toBe(false)
  }, 20_000)
})

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

describe('concurrency helpers', () => {
  test('normalizedConcurrency matches 1.x for every accepted value', async () => {
    const old = await legacy<{
      normalizedConcurrency: (value: number | undefined) => number
    }>('engine/scheduling/parallel.js')
    for (const value of [undefined, 1, 2, 3.9, 0, -4, 0.5, 17]) {
      expect(normalizedConcurrency(value)).toBe(
        old.normalizedConcurrency(value),
      )
    }
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'normalizedConcurrency rejects %s',
    (value) => {
      expect(() => normalizedConcurrency(value)).toThrow('finite')
    },
  )

  test('groupBy keeps insertion order', () => {
    expect([...groupBy([1, 2, 3, 4, 5], (value) => value % 2)]).toEqual([
      [1, [1, 3, 5]],
      [0, [2, 4]],
    ])
  })

  test('parallelMap keeps input order and honors the bound', async () => {
    let running = 0
    let peak = 0
    const results = await parallelMap(
      [5, 4, 3, 2, 1],
      2,
      async (value, index) => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, value * 3))
        running -= 1
        return `${index}:${value}`
      },
    )
    expect(results).toEqual(['0:5', '1:4', '2:3', '3:2', '4:1'])
    expect(peak).toBe(2)
  })

  test('parallelMap rejects with the first failure', async () => {
    await expect(
      parallelMap([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error('boom')
        return value
      }),
    ).rejects.toThrow('boom')
  })
})
