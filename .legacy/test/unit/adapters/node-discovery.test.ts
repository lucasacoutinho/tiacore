import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import {
  canonicalNodePath,
  parseNodeDiscoveryRecords,
} from '../../../src/adapters/node/discovery.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('node:test discovery paths', () => {
  test('normalizes file URLs before applying the project boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-node-paths-'))
    temporaryDirectories.push(root)
    const file = join(root, 'example.test.mjs')
    writeFileSync(file, "import test from 'node:test'\n")
    const url = pathToFileURL(file).href

    expect(canonicalNodePath(url)).toBe(realpathSync.native(file))
    expect(
      parseNodeDiscoveryRecords(
        root,
        `${JSON.stringify({
          column: 1,
          file: url,
          fullName: 'example case',
          line: 1,
          name: 'example case',
          skipped: false,
        })}\n`,
      ),
    ).toEqual([
      expect.objectContaining({
        file: 'example.test.mjs',
        fullName: 'example case',
        state: 'passed',
      }),
    ])
  })
})
