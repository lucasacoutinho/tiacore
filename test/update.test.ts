import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { updateGraph } from '../src/graph/update.js'
import type { TiaGraph } from '../src/shared/types.js'

const temporaryDirectories: string[] = []

function graph(): TiaGraph {
  return {
    baseline: { sha: 'baseline', workingTree: {} },
    collectionCoverage: {
      'test/a.test.ts': {},
      'test/deleted.test.ts': {},
    },
    complete: true,
    coverageComplete: true,
    edges: {
      'test/a.test.ts': ['src/old.ts', 'test/a.test.ts'],
      'test/deleted.test.ts': ['test/deleted.test.ts'],
    },
    fingerprint: 'fingerprint',
    results: {
      old: {
        file: 'test/a.test.ts',
        fullName: 'old case',
        id: 'old',
        state: 'passed',
      },
      removed: {
        file: 'test/deleted.test.ts',
        fullName: 'removed case',
        id: 'removed',
        state: 'passed',
      },
    },
    schema: 3,
    testCoverage: {
      old: {},
      removed: {},
    },
    testEdges: {
      old: {
        file: 'test/a.test.ts',
        files: ['src/old.ts', 'test/a.test.ts'],
      },
      removed: {
        file: 'test/deleted.test.ts',
        files: ['test/deleted.test.ts'],
      },
    },
    updatedAt: new Date(0).toISOString(),
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('shared graph updates', () => {
  test('replaces whole files and prunes deleted files atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-update-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'test'))
    writeFileSync(join(root, 'test/a.test.ts'), 'test("a", () => {})\n')

    const updated = updateGraph({
      collectionCoverage: new Map([['test/a.test.ts', {}]]),
      executedFiles: ['test/a.test.ts'],
      fullyExecutedFiles: ['test/a.test.ts'],
      previous: graph(),
      results: new Map([[
        'new',
        {
          file: 'test/a.test.ts',
          fullName: 'new case',
          id: 'new',
          state: 'passed',
        },
      ]]),
      root,
      testCoverage: new Map([['new', {}]]),
      testEdges: new Map([[
        'new',
        {
          file: 'test/a.test.ts',
          files: ['src/new.ts', 'test/a.test.ts'],
        },
      ]]),
    })

    expect(updated.results).toEqual({
      new: expect.objectContaining({ fullName: 'new case' }),
    })
    expect(updated.testEdges).toEqual({
      new: {
        file: 'test/a.test.ts',
        files: ['src/new.ts', 'test/a.test.ts'],
      },
    })
    expect(updated.testCoverage).toEqual({ new: {} })
    expect(updated.edges).toEqual({
      'test/a.test.ts': ['src/new.ts', 'test/a.test.ts'],
    })
    expect(updated.collectionCoverage).toEqual({
      'test/a.test.ts': {},
    })
  })
})
