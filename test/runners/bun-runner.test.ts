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
  test('rejects a NaN or infinite concurrency', () => {
    expect(() => tia({ concurrency: Number.NaN })).toThrow(
      'concurrency must be a finite number',
    )
    expect(() => tia({ concurrency: Number.POSITIVE_INFINITY })).toThrow(
      'concurrency must be a finite number',
    )
  })

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
  // Bun cannot tell a removed case from a case that did not run: the run that
  // selects it matches no test, a module failure of its file. That run fails
  // but saves the graph, and the next run runs the file whole.
  test('a data-driven file that loses a row fails once, then runs whole', async () => {
    const root = project({
      'src/rows.ts': "export const rows = ['a', 'b', 'c']\n",
      'test/rows.test.ts': `import { test } from 'bun:test'
import { rows } from '../src/rows'

for (const row of rows) {
  test(row, () => {})
}
`,
    })
    const runner = () => tia({ ...OPTIONS, root }).run()
    expect((await runner()).graphSaved).toBe(true)

    writeFileSync(join(root, 'src/rows.ts'), "export const rows = ['a', 'c']\n")
    const removed = await runner()
    expect(removed.plan.affectedTestIds).toHaveLength(3)
    expect(removed.success).toBe(false)
    expect(removed.graphSaved).toBe(true)
    expect(
      removed.executedTests.map((item) => [item.fullName, item.state]).sort(),
    ).toEqual([
      ['a', 'passed'],
      ['c', 'passed'],
      ['test/rows.test.ts (module failure)', 'failed'],
    ])

    const rerun = await runner()
    expect(rerun.plan.wholeTestFiles).toEqual(['test/rows.test.ts'])
    expect(rerun.success).toBe(true)
    expect(rerun.graphSaved).toBe(true)
    expect(rerun.executedTests.map((item) => item.fullName).sort()).toEqual([
      'a',
      'c',
    ])
  })

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

  test('replays an affected case on its own and saves the graph', async () => {
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'src/b.ts': 'export const b = () => 2\n',
      'test/ab.test.ts': `import { expect, test } from 'bun:test'

test('uses a', async () => {
  const { a } = await import('../src/a')
  expect(a()).toBe(1)
})
test('uses b', async () => {
  const { b } = await import('../src/b')
  expect(b()).toBe(2)
})
`,
    })
    const recorded = await tia({ ...OPTIONS, root }).run()
    expect(recorded.success).toBe(true)
    expect(recorded.graphSaved).toBe(true)

    writeFileSync(join(root, 'src/a.ts'), 'export const a = () => 1 + 0\n')
    const replayed = await tia({ ...OPTIONS, root }).run()
    expect(replayed.plan.mode).toBe('replay')
    expect(replayed.executedTests.map((item) => [item.id, item.state])).toEqual(
      [['test/ab.test.ts:3:uses a', 'passed']],
    )
    expect(replayed.success).toBe(true)
    expect(replayed.graphSaved).toBe(true)
  })

  test('a failing case inside describe fails the run, also beside a describe.skip group', async () => {
    // The describe.skip group makes Bun exit 0 when the selection matches nothing.
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'test/nested.test.ts': `import { describe, expect, test } from 'bun:test'
import { a } from '../src/a'

test('top', () => {
  a()
})
describe('group', () => {
  test('fails inside', () => {
    expect(1).toBe(2)
  })
})
describe.skip('parked', () => {
  test('later', () => {})
})
`,
    })
    const result = await tia({ ...OPTIONS, root }).run()
    expect(result.success).toBe(false)
    expect(
      result.executedTests.filter(
        (item) =>
          item.fullName.endsWith('fails inside') && item.state !== 'failed',
      ),
    ).toEqual([])
    expect(
      result.executedTests.find((item) => item.fullName === 'top'),
    ).toMatchObject({ state: 'passed' })
  })

  test('a passing top-level case does not hide a same-named failing case inside describe', async () => {
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'test/same.test.ts': `import { describe, expect, test } from 'bun:test'
import { a } from '../src/a'

test('same', () => {
  a()
})
describe('group', () => {
  test('same', () => {
    expect(1).toBe(2)
  })
})
`,
    })
    const result = await tia({ ...OPTIONS, root }).run()
    expect(result.success).toBe(false)
    expect(
      result.executedTests
        .filter((item) => item.state !== 'failed')
        .map((item) => item.id),
    ).toEqual(['test/same.test.ts:4:same'])
  })

  test('a case named with a tab, line feed or carriage return is recorded on its own', async () => {
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'test/names.test.ts': `import { test } from 'bun:test'
import { a } from '../src/a'

a()
test('tab\\there', () => {})
test('line\\nfeed', () => {})
test('carriage\\rreturn', () => {})
`,
    })
    const result = await tia({ ...OPTIONS, root }).run()
    expect(
      result.executedTests.map((item) => [item.fullName, item.state]),
    ).toEqual([
      ['tab\there', 'passed'],
      ['line\nfeed', 'passed'],
      ['carriage\rreturn', 'passed'],
    ])
    expect(result.success).toBe(true)
  })

  test('a case failing with markup and control characters in its message is recorded as failed', async () => {
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'test/message.test.ts': `import { test } from 'bun:test'
import { a } from '../src/a'

test('throws', () => {
  a()
  throw new Error('<b>& "q" \\'s\\' ]]> \\u001b[31mred\\u001b[0m \\u0000 nul')
})
`,
    })
    const result = await tia({ ...OPTIONS, root }).run()
    expect(result.executedTests.map((item) => [item.id, item.state])).toEqual([
      ['test/message.test.ts:4:throws', 'failed'],
    ])
  })

  test('a throwing afterAll hook makes its file one module failure', async () => {
    const root = project({
      'src/a.ts': 'export const a = () => 1\n',
      'test/teardown.test.ts': `import { afterAll, test } from 'bun:test'
import { a } from '../src/a'

test('a', () => {
  a()
})
test('b', () => {})
afterAll(() => {
  throw new Error('teardown failed')
})
`,
    })
    const result = await tia({ ...OPTIONS, root }).run()
    expect(result.success).toBe(false)
    expect(result.executedTests.map((item) => item.id)).toEqual([
      'module:test/teardown.test.ts',
    ])
  })

  // A documented limitation, kept fail-closed.
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
