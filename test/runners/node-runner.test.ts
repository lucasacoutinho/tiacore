import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { runPromise } from '../../src/host/runtime.ts'
import { tia } from '../../src/entries/node.ts'
import { nodeHelperPath } from '../../src/runners/node/assets.ts'
import {
  executeNode,
  observeNodeFiles,
  type NodeContext,
} from '../../src/runners/node/observe.ts'
import { initRepository } from '../support/runner-project.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tiacore-node-run-')))
  temporaryDirectories.push(root)
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, '.gitignore'), '.tia/\n')
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  initRepository(root)
  return root
}

function context(root: string, extra: Partial<NodeContext> = {}): NodeContext {
  const register = nodeHelperPath('discovery-register.js')
  const execution = nodeHelperPath('execution-child.js')
  if (register === null || execution === null) {
    throw new Error('run npm run build first')
  }
  return {
    concurrency: 2,
    helpers: { execution, register },
    log: false,
    root,
    ...extra,
  }
}

const GOOD_TEST = `import assert from 'node:assert/strict'
import test from 'node:test'
import { value } from '../src/value.mjs'

test('good case', () => {
  assert.equal(value, 1)
})
`
const BROKEN_TEST = `import test from 'node:test'
import './missing.mjs'

test('never registered', () => {})
`
const HANGING_TEST = `import test from 'node:test'

await new Promise((resolve) => setTimeout(resolve, 60_000))
test('never reached', () => {})
`

describe('node runner child processes', () => {
  test('an execution child reports cases and the project files that ran', async () => {
    const root = project({
      'src/value.mjs': 'export const value = 1\n',
      'test/good.test.mjs': GOOD_TEST,
    })
    const execution = await runPromise(
      executeNode(context(root), [join(root, 'test/good.test.mjs')], undefined),
    )
    expect(execution.success).toBe(true)
    expect(execution.moduleFailures).toEqual([])
    expect(execution.cases.map((item) => [item.fullName, item.state])).toEqual([
      ['good case', 'passed'],
    ])
    expect(execution.coverageFiles).toEqual(
      expect.arrayContaining(['src/value.mjs', 'test/good.test.mjs']),
    )
  })

  test('a timed-out child becomes a synthetic failure of every requested file', async () => {
    const root = project({ 'test/hang.test.mjs': HANGING_TEST })
    const execution = await runPromise(
      executeNode(
        context(root, { timeoutMs: 1_500 }),
        [join(root, 'test/hang.test.mjs')],
        undefined,
      ),
    )
    expect(execution).toEqual({
      cases: [],
      coverageFiles: [],
      moduleFailures: ['test/hang.test.mjs'],
      success: false,
    })
  })

  test('a module that fails to load is a module failure, not a case', async () => {
    const root = project({ 'test/broken.test.mjs': BROKEN_TEST })
    const execution = await runPromise(
      executeNode(
        context(root),
        [join(root, 'test/broken.test.mjs')],
        undefined,
      ),
    )
    expect(execution.cases).toEqual([])
    expect(execution.moduleFailures).toEqual(['test/broken.test.mjs'])
    expect(execution.success).toBe(false)
  })
})

describe('node aggregate mode (Node without discovery hooks)', () => {
  // A module failure or timeout must never commit a complete graph.
  test('a module failure makes the batch incomplete', async () => {
    vi.stubEnv('TIACORE_NODE_DISCOVERY_HOOKS', '0')
    const root = project({
      'src/value.mjs': 'export const value = 1\n',
      'test/broken.test.mjs': BROKEN_TEST,
      'test/good.test.mjs': GOOD_TEST,
    })
    const observed = await runPromise(
      observeNodeFiles(context(root), [
        join(root, 'test/broken.test.mjs'),
        join(root, 'test/good.test.mjs'),
      ]),
    )
    expect(observed.complete).toBe(false)
  })

  test('a timeout makes the batch incomplete', async () => {
    vi.stubEnv('TIACORE_NODE_DISCOVERY_HOOKS', '0')
    const root = project({ 'test/hang.test.mjs': HANGING_TEST })
    const observed = await runPromise(
      observeNodeFiles(context(root, { timeoutMs: 1_500 }), [
        join(root, 'test/hang.test.mjs'),
      ]),
    )
    expect(observed.complete).toBe(false)
    expect(observed.observations).toEqual([])
  })

  test('a clean batch is complete and every case depends on the whole run', async () => {
    vi.stubEnv('TIACORE_NODE_DISCOVERY_HOOKS', '0')
    const root = project({
      'src/value.mjs': 'export const value = 1\n',
      'test/good.test.mjs': GOOD_TEST,
    })
    const observed = await runPromise(
      observeNodeFiles(context(root), [join(root, 'test/good.test.mjs')]),
    )
    expect(observed.complete).toBe(true)
    expect(observed.observations).toHaveLength(1)
    expect(observed.observations[0]?.files).toEqual(
      expect.arrayContaining(['src/value.mjs', 'test/good.test.mjs']),
    )
  })

  test('a run with a module failure neither succeeds nor saves a graph', async () => {
    vi.stubEnv('TIACORE_NODE_DISCOVERY_HOOKS', '0')
    const root = project({
      'src/value.mjs': 'export const value = 1\n',
      'test/broken.test.mjs': BROKEN_TEST,
      'test/good.test.mjs': GOOD_TEST,
    })
    const result = await tia({
      files: ['test/**/*.test.mjs'],
      log: false,
      root,
    }).run()
    expect(result.success).toBe(false)
    expect(result.graphSaved).toBe(false)
    expect(existsSync(join(root, '.tia/node/state.json'))).toBe(false)
  })
})

describe('node runner options', () => {
  test('rejects a NaN or infinite concurrency instead of dropping or unbounding work', () => {
    expect(() => tia({ concurrency: Number.NaN })).toThrow(
      'concurrency must be a finite number',
    )
    expect(() => tia({ concurrency: Number('abc') })).toThrow(
      'concurrency must be a finite number',
    )
    expect(() => tia({ concurrency: Number.POSITIVE_INFINITY })).toThrow(
      'concurrency must be a finite number',
    )
    expect(() => tia({ concurrency: 0.5, log: false })).not.toThrow()
  })

  test('refuses an old Node before reading or writing anything', async () => {
    const root = project({ 'test/good.test.mjs': GOOD_TEST })
    const runner = tia({ log: false, root })
    const original = process.versions.node
    Object.defineProperty(process.versions, 'node', {
      configurable: true,
      value: '22.9.0',
    })
    try {
      await expect(runner.run()).rejects.toThrow(
        'requires Node.js 22.10 or newer for programmatic test coverage',
      )
    } finally {
      Object.defineProperty(process.versions, 'node', {
        configurable: true,
        value: original,
      })
    }
    expect(existsSync(join(root, '.tia'))).toBe(false)
  })

  test('keeps the cache under the real path of a symlinked root', async () => {
    const root = project({
      'src/value.mjs': 'export const value = 1\n',
      'test/good.test.mjs': GOOD_TEST,
    })
    const link = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'tiacore-node-link-'))),
      'linked',
    )
    temporaryDirectories.push(join(link, '..'))
    symlinkSync(root, link)
    const result = await tia({
      files: ['test/**/*.test.mjs'],
      log: false,
      root: link,
    }).run()
    expect(result.success).toBe(true)
    expect(existsSync(join(root, '.tia/node'))).toBe(true)
  })

  test('an empty file set still commits an empty baseline', async () => {
    const root = project({ 'README.md': 'nothing to test\n' })
    const result = await tia({
      files: ['test/**/*.test.mjs'],
      log: false,
      root,
    }).run()
    expect(result.success).toBe(true)
    expect(result.graphSaved).toBe(true)
    expect(result.executedTests).toEqual([])
  })
})
