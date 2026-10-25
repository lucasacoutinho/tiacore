import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { readNodeV8CoverageFiles } from '../../src/runners/node/coverage.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function script(file: string, count: number): object {
  return {
    functions: [{ ranges: [{ count }] }],
    url: pathToFileURL(file).href,
  }
}

describe('node:test V8 coverage fallback', () => {
  test('collects executed project files from child-process coverage', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-node-v8-'))
    temporaryDirectories.push(root)
    const directory = join(root, 'coverage')
    const source = join(root, 'src/value.mjs')
    const dependency = join(root, 'node_modules/example/index.mjs')
    mkdirSync(directory)
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules/example'), { recursive: true })
    writeFileSync(source, "export const value = 'ok'\n")
    writeFileSync(dependency, "export const dependency = 'ignored'\n")
    writeFileSync(
      join(directory, 'coverage.json'),
      JSON.stringify({
        result: [
          script(source, 1),
          script(dependency, 1),
          script(join(root, 'src/unused.mjs'), 0),
        ],
      }),
    )

    expect(readNodeV8CoverageFiles(directory, root)).toEqual(['src/value.mjs'])
  })

  // NODE-COV-01 (missing directory), NODE-COV-02, NODE-COV-03
  test('filters only a root-level node_modules and skips unreadable files', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-node-v8-'))
    temporaryDirectories.push(root)
    const directory = join(root, 'coverage')
    mkdirSync(directory)
    mkdirSync(join(root, 'packages/x/node_modules/y'), { recursive: true })
    const nested = join(root, 'packages/x/node_modules/y/index.mjs')
    writeFileSync(nested, '')
    const outside = join(tmpdir(), 'tiacore-outside-source.mjs')
    writeFileSync(
      join(directory, 'one.json'),
      JSON.stringify({ result: [script(nested, 2), script(outside, 2)] }),
    )
    writeFileSync(join(directory, 'half-written.json'), '{"result": [')
    writeFileSync(join(directory, 'notes.txt'), 'ignored')

    expect(readNodeV8CoverageFiles(directory, root)).toEqual([
      'packages/x/node_modules/y/index.mjs',
    ])
    expect(readNodeV8CoverageFiles(join(root, 'missing'), root)).toEqual([])
  })
})
