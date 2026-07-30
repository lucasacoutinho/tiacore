import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  createProject,
  executions,
  readGraph,
  resetExecutions,
  runCommand,
  runVitest,
} from './helpers/integration-project.js'
import {
  commitGraph,
  graphDigest,
  readGraph as readStateGraph,
  writeGraph,
} from '../src/graph/state.js'
import type { TiaGraph } from '../src/shared/types.js'

const temporaryDirectories: string[] = []
const lockHolder = fileURLToPath(
  new URL('./fixtures/transaction-lock-holder.mjs', import.meta.url),
)

function transactionGraph(updatedAt: string): TiaGraph {
  return {
    baseline: { sha: 'baseline', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: false,
    edges: {},
    fingerprint: 'failure-injection',
    results: {},
    schema: 3,
    testCoverage: {},
    testEdges: {},
    updatedAt,
  }
}

async function crashLockHolder(cacheDir: string): Promise<void> {
  const child = spawn(process.execPath, [lockHolder, cacheDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolveReady, rejectReady) => {
    child.on('error', rejectReady)
    child.stdout.on('data', (value) => {
      if (String(value).includes('ready')) {
        resolveReady()
      }
    })
  })
  child.kill('SIGKILL')
  await new Promise<void>((resolveClosed) => {
    child.on('close', () => resolveClosed())
  })
}

afterEach(() => {
  cleanupProjects()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('failure injection', () => {
  test('recovers a killed graph writer and removes its partial atomic file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-writer-crash-'))
    temporaryDirectories.push(root)
    const cacheDir = join(root, '.tia')
    const expected = transactionGraph(new Date(0).toISOString())
    const proposed = transactionGraph(new Date(1).toISOString())
    writeGraph(cacheDir, expected)

    await crashLockHolder(cacheDir)
    const committed = await commitGraph(cacheDir, {
      expected,
      expectedDigest: graphDigest(expected),
      graph: proposed,
      lockTimeoutMs: 1_000,
    })

    expect(committed.status).toBe('committed')
    expect(readStateGraph(cacheDir)).toEqual(proposed)
    expect(existsSync(join(cacheDir, 'graph.lock'))).toBe(false)
    expect(
      readdirSync(cacheDir).filter((file) => file.endsWith('.tmp')),
    ).toEqual([])
  })

  test('records a killed Node coverage worker as a failure and recovers it', () => {
    const root = createFixtureProject('node-worker-crash')
    const initial = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(initial.status, initial.output).toBe(0)

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/value.mjs'),
      "export const value = () => 'stable'\n// changed\n",
    )
    const crashed = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      20_000,
      { TIACORE_INJECT_WORKER_CRASH: '1' },
    )
    expect(crashed.status, crashed.output).toBe(1)
    expect(
      Object.values(readGraph(root, 'node').results),
    ).toEqual([
      expect.objectContaining({
        fullName: 'test/crash.test.mjs (module failure)',
        state: 'failed',
      }),
    ])

    resetExecutions(root)
    const recovered = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
    )
    expect(recovered.status, recovered.output).toBe(0)
    expect(executions(root)).toEqual(['worker'])
    expect(
      Object.values(readGraph(root, 'node').results),
    ).toEqual([
      expect.objectContaining({
        fullName: 'worker crash case',
        state: 'passed',
      }),
    ])
  })

  test('records one crashing Bun module without dropping healthy files', () => {
    const root = createFixtureProject('bun-parallel')
    writeFileSync(
      join(root, 'test/a.test.ts'),
      "throw new Error('injected Bun module failure')\n",
    )

    const failed = runCommand(root, 'bun', ['run-tia.ts'])

    expect(failed.status, failed.output).toBe(1)
    expect(executions(root)).toEqual(['bun-b'])
    expect(
      Object.values(readGraph(root, 'bun').results),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullName: 'test/a.test.ts (module failure)',
          state: 'failed',
        }),
        expect.objectContaining({
          fullName: 'parallel bun b',
          state: 'passed',
        }),
      ]),
    )
  })

  test('fails closed when a Bun case crashes after discovery', () => {
    const root = createFixtureProject('bun-parallel')
    const markerDirectory = mkdtempSync(
      join(tmpdir(), 'tiacore-bun-marker-'),
    )
    temporaryDirectories.push(markerDirectory)
    const marker = join(markerDirectory, 'discovered')
    writeFileSync(
      join(root, 'test/a.test.ts'),
      `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { value } from '../src/a'

const marker = process.env.TIACORE_INJECT_BUN_MARKER
if (marker) {
  if (existsSync(marker)) {
    process.exit(42)
  }
  writeFileSync(marker, 'discovered')
}

test('parallel bun a', () => {
  appendFileSync('executions.log', 'bun-a\\n')
  expect(value).toBe('a')
})
`,
    )

    const failed = runCommand(
      root,
      'bun',
      ['run-tia.ts'],
      20_000,
      { TIACORE_INJECT_BUN_MARKER: marker },
    )

    expect(failed.status, failed.output).toBe(1)
    expect(executions(root)).toEqual(['bun-b'])
    expect(
      Object.values(readGraph(root, 'bun').results),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fullName: 'test/a.test.ts (module failure)',
          state: 'failed',
        }),
      ]),
    )
  })

  test('preserves the previous Vitest graph when a fork worker exits', () => {
    const root = createProject({
      testA: `import { appendFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { a } from '../src/a'

test('worker exit case', () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a\\n')
  if (process.env.TIACORE_INJECT_VITEST_EXIT === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
  expect(a()).toBe('a')
})
`,
    })
    const initial = runVitest(root, ['run', '--pool=forks'])
    expect(initial.status, initial.output).toBe(0)
    const graphFile = join(root, '.tia/graph.json')
    const before = readFileSync(graphFile, 'utf8')

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/a.ts'),
      "export const a = () => 'a'\n// changed\n",
    )
    const crashed = runVitest(
      root,
      ['run', '--pool=forks'],
      20_000,
      { TIACORE_INJECT_VITEST_EXIT: '1' },
    )
    expect(crashed.status).not.toBe(0)
    expect(readFileSync(graphFile, 'utf8')).toBe(before)

    resetExecutions(root)
    const recovered = runVitest(root, ['run', '--pool=forks'])
    expect(recovered.status, recovered.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
  })
})
