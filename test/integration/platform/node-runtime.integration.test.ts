import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { initRepository, readGraph } from '../../support/runner-project.ts'

const temporaryDirectories: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-platform-node-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'src/value.mjs'), "export const value = 'a'\n")
  writeFileSync(
    join(root, 'test/value.test.mjs'),
    `import { appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

test('platform value case', async () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'value\\n')
  const { value } = await import('../src/value.mjs')
  assert.equal(value, 'a')
})
`,
  )
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, '.gitignore'), '.tia/\nexecutions.log\n')
  initRepository(root)
  return root
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('native Node adapter on the host platform', () => {
  test('records, replays, and selects with native paths and processes', async () => {
    const moduleUrl = pathToFileURL(
      join(process.cwd(), 'dist/entries/node.js'),
    ).href
    const nodeApi: typeof import('../../../src/entries/node.ts') = await import(
      moduleUrl
    )
    const root = project()
    const options = {
      files: ['test/**/*.test.mjs'],
      fresh: false,
      log: false,
      root,
    }

    const initial = await nodeApi.tia(options).run()
    expect(initial).toMatchObject({
      graphSaved: true,
      success: true,
    })
    expect(initial.plan.mode).toBe('record')
    expect(await readGraph(root, 'node')).toMatchObject({
      complete: true,
    })

    const replay = await nodeApi.tia(options).run()
    expect(replay.plan).toMatchObject({
      affectedTestIds: [],
      mode: 'replay',
    })

    writeFileSync(
      join(root, 'src/value.mjs'),
      "export const value = 'a'\n// platform change\n",
    )
    const changed = await nodeApi.tia(options).run()
    expect(changed.plan.mode).toBe('replay')
    expect(changed.plan.affectedTestIds).toHaveLength(1)
    expect(changed.executedTests).toHaveLength(1)
    expect(
      readFileSync(join(root, 'executions.log'), 'utf8').trim().split(/\r?\n/u),
    ).toEqual(['value', 'value'])
  }, 30_000)
})
