import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { tia } from '../../src/entries/bun.ts'
import { initRepository } from '../support/runner-project.ts'

const hasBun = spawnSync('bun', ['--version']).status === 0
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tiacore-bun-run-')))
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

const OPTIONS = { files: ['test/**/*.test.ts'], log: false }

describe('bun runner options', () => {
  test('rejects a NaN concurrency', () => {
    expect(() => tia({ concurrency: Number.NaN })).toThrow(
      'concurrency must be a number',
    )
  })

  // BUN-OPT-01
  test('an unspawnable binary turns every file into a module failure and still saves the graph', async () => {
    const root = project({
      'src/a.ts': 'export const a = 1\n',
      'test/a.test.ts':
        "import { test } from 'bun:test'\ntest('a', () => {})\n",
      'test/b.test.ts':
        "import { test } from 'bun:test'\ntest('b', () => {})\n",
    })
    const result = await tia({
      ...OPTIONS,
      binary: join(root, 'no-such-bun'),
      root,
    }).run()
    expect(result.success).toBe(false)
    expect(result.graphSaved).toBe(true)
    expect(result.executedTests.map((item) => item.id).sort()).toEqual([
      'module:test/a.test.ts',
      'module:test/b.test.ts',
    ])
  })
})

describe.skipIf(!hasBun)('bun runner with bun installed', () => {
  // BUN-FAIL-01
  test('records a genuinely failing test as a failed case with its coverage', async () => {
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'test/a.test.ts': `import { expect, test } from 'bun:test'
import { a } from '../src/a'

test('fails', () => {
  expect(a()).toBe(2)
})
`,
    })
    const result = await tia({ ...OPTIONS, root }).run()
    expect(result.success).toBe(false)
    expect(result.graphSaved).toBe(true)
    const [failed] = result.executedTests
    expect(failed).toMatchObject({ fullName: 'fails', state: 'failed' })
    expect(failed?.files).toEqual(['src/a.ts', 'test/a.test.ts'])
  })

  // BUN-FAIL-04: documented limitation, kept fail-closed.
  test('cases inside describe, and skip or todo cases, stay file-level module failures', async () => {
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'test/mixed.test.ts': `import { describe, test } from 'bun:test'
import { a } from '../src/a'

test('top level', () => {
  a()
})
describe('group', () => {
  test('inside describe', () => {})
})
test.skip('skipped', () => {})
test.todo('todo')
`,
    })
    const result = await tia({ ...OPTIONS, root }).run()
    const ids = result.executedTests.map((item) => item.id)
    expect(ids).toContain('module:test/mixed.test.ts')
    expect(
      result.executedTests.find((item) => item.fullName === 'top level'),
    ).toMatchObject({ state: 'passed' })
    expect(result.success).toBe(false)
    expect(result.graphSaved).toBe(true)
  })
})
