import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { readNodeV8CoverageFiles } from '../../../src/adapters/node/coverage.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

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
          {
            functions: [{ ranges: [{ count: 1 }] }],
            url: pathToFileURL(source).href,
          },
          {
            functions: [{ ranges: [{ count: 1 }] }],
            url: pathToFileURL(dependency).href,
          },
          {
            functions: [{ ranges: [{ count: 0 }] }],
            url: pathToFileURL(join(root, 'src/unused.mjs')).href,
          },
        ],
      }),
    )

    expect(readNodeV8CoverageFiles(directory, root)).toEqual(['src/value.mjs'])
  })
})
