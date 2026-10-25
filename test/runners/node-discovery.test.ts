import {
  mkdirSync,
  mkdtempSync,
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
  nodeTestId,
  nodeVersionSupported,
  parseNodeDiscoveryRecords,
} from '../../src/runners/node/discovery.ts'
import { canonicalNodePath } from '../../src/runners/node/paths.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-node-paths-'))
  temporaryDirectories.push(root)
  return root
}

function record(file: string, extra: object = {}): string {
  return JSON.stringify({
    column: 3,
    file,
    fullName: 'suite case',
    line: 7,
    name: 'case',
    skipped: false,
    ...extra,
  })
}

describe('node:test discovery paths', () => {
  test('normalizes file URLs before applying the project boundary', () => {
    const root = scratch()
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

  test('builds ids from the root-relative path, position and full name', () => {
    const root = scratch()
    mkdirSync(join(root, 'test'))
    const inside = join(root, 'test/a.test.mjs')
    writeFileSync(inside, '')
    const outside = join(scratch(), 'b.test.mjs')
    writeFileSync(outside, '')
    const source = [
      record(inside),
      '',
      record(inside, { fullName: 'suite skipped', skipped: true }),
      record(outside),
      'not json',
      JSON.stringify({ file: inside }),
      '',
    ].join('\n')

    const cases = parseNodeDiscoveryRecords(root, source)
    expect(cases.map((item) => [item.id, item.state, item.name])).toEqual([
      ['test/a.test.mjs:7:3:suite case', 'passed', 'case'],
      ['test/a.test.mjs:7:3:suite skipped', 'skipped', 'case'],
    ])
    expect(nodeTestId('a.test.mjs', 1, 2, 'x y')).toBe('a.test.mjs:1:2:x y')
  })
})

describe('node version gates', () => {
  test('programmatic coverage needs 22.10 and discovery hooks need 22.15', () => {
    expect(nodeVersionSupported('22.9.0')).toBe(false)
    expect(nodeVersionSupported('22.10.0')).toBe(true)
    expect(nodeVersionSupported('24.0.0')).toBe(true)
    expect(nodeVersionSupported('20.19.0')).toBe(false)

    expect(nodeDiscoveryHooksSupported('22.12.0', {})).toBe(false)
    expect(nodeDiscoveryHooksSupported('22.14.9', {})).toBe(false)
    expect(nodeDiscoveryHooksSupported('22.15.0', {})).toBe(true)
    expect(nodeDiscoveryHooksSupported('24.0.0', {})).toBe(true)
    expect(
      nodeDiscoveryHooksSupported('24.0.0', {
        TIACORE_NODE_DISCOVERY_HOOKS: '0',
      }),
    ).toBe(false)
    expect(
      nodeDiscoveryHooksSupported('24.0.0', {
        TIACORE_NODE_DISCOVERY_HOOKS: '1',
      }),
    ).toBe(true)
  })
})
