import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  nodeDiscoveryHooksSupported,
  parseNodeDiscoveryRecords,
} from '../../src/runners/node/discovery.ts'
import { nodeHelperPath } from '../../src/runners/node/assets.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

const hooks = nodeDiscoveryHooksSupported(process.versions.node, {})

function discover(
  root: string,
  file: string,
): {
  cases: ReturnType<typeof parseNodeDiscoveryRecords>
  status: number | null
} {
  const register = nodeHelperPath('discovery-register.js')
  if (register === null) throw new Error('run npm run build first')
  const output = join(root, 'cases.jsonl')
  writeFileSync(output, '')
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TIACORE_NODE_DISCOVERY_FILE: output,
  }
  delete environment['NODE_TEST_CONTEXT']
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(register).href, file],
    { cwd: root, encoding: 'utf8', env: environment },
  )
  return {
    cases: parseNodeDiscoveryRecords(root, readFileSync(output, 'utf8')),
    status: result.status,
  }
}

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tiacore-shim-')))
  temporaryDirectories.push(root)
  return root
}

describe.skipIf(!hooks)('node:test discovery shim', () => {
  // NODE-SHIM-01, NODE-SHIM-03, NODE-SHIM-04, NODE-SHIM-06
  test('records ESM tests without running their bodies, with real skip and todo', () => {
    const root = project()
    const file = join(root, 'esm.test.mjs')
    writeFileSync(
      file,
      `import { appendFileSync } from 'node:fs'
import test, { describe, it, skip, todo } from 'node:test'

const ran = () => appendFileSync(new URL('./ran.log', import.meta.url), 'x')

test('plain', ran)
test.skip('skipped by call', ran)
it.todo('todo by call', ran)
test('skipped by option', { skip: true }, ran)
test('todo by option', { todo: 'later' }, ran)
test(function namedCallback() { ran() })
test(() => {})
test.only('only is plain', ran)
describe('suite', () => {
  it('inner', ran)
  describe('nested', () => {
    test('deep', ran)
  })
})
describe.skip('skipped suite', () => {
  test('hidden', ran)
})
describe('option skipped suite', { skip: true }, () => {
  test('also hidden', ran)
})
console.log(typeof skip, typeof todo)
`,
    )

    const { cases, status } = discover(root, file)
    expect(status).toBe(0)
    expect(existsSync(join(root, 'ran.log'))).toBe(false)
    expect(cases.map((item) => [item.fullName, item.state])).toEqual([
      ['plain', 'passed'],
      ['skipped by call', 'skipped'],
      ['todo by call', 'skipped'],
      ['skipped by option', 'skipped'],
      ['todo by option', 'skipped'],
      ['namedCallback', 'passed'],
      ['<anonymous>', 'passed'],
      ['only is plain', 'passed'],
      ['suite inner', 'passed'],
      ['suite nested deep', 'passed'],
      ['skipped suite hidden', 'skipped'],
      ['option skipped suite also hidden', 'skipped'],
    ])
    const plain = cases[0]
    expect(plain).toMatchObject({
      column: 1,
      file: 'esm.test.mjs',
      id: 'esm.test.mjs:6:1:plain',
      line: 6,
    })
  })

  // NODE-SHIM-01 (CommonJS), NODE-SHIM-07
  test('redirects require("node:test") to a callable shim', () => {
    const root = project()
    const file = join(root, 'cjs.test.cjs')
    writeFileSync(
      file,
      `const test = require('node:test')
const { describe, it } = require('node:test')
const bare = require('test')

test('cjs plain', () => {})
test.skip('cjs skipped', () => {})
describe('cjs suite', () => {
  it('cjs inner', () => {})
})
if (typeof bare !== 'function' || typeof test.describe !== 'function') {
  throw new Error('the shim is not a callable module object')
}
`,
    )

    const { cases, status } = discover(root, file)
    expect(status).toBe(0)
    expect(cases.map((item) => [item.fullName, item.state])).toEqual([
      ['cjs plain', 'passed'],
      ['cjs skipped', 'skipped'],
      ['cjs suite cjs inner', 'passed'],
    ])
  })

  test('a file that throws at load fails the discovery child', () => {
    const root = project()
    const file = join(root, 'broken.test.mjs')
    writeFileSync(
      file,
      "import test from 'node:test'\nimport './missing.mjs'\ntest('x', () => {})\n",
    )
    expect(discover(root, file).status).not.toBe(0)
  })
})
