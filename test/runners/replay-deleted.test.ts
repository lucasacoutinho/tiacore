import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { TiaCore, type TiaObservation } from '../../src/entries/core.ts'
import { initRepository } from '../support/runner-project.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function observation(name: string): TiaObservation {
  return {
    file: `test/${name}.test.ts`,
    files: [`test/${name}.test.ts`, `src/${name}.ts`],
    fullName: `${name} case`,
    id: `${name}-case`,
    state: 'passed',
  }
}

// Cached results of test files that no longer exist are neither replayed nor
// counted.
describe('results of deleted test files', () => {
  test('are neither replayed nor counted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-deleted-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'test'))
    for (const name of ['a', 'b']) {
      writeFileSync(join(root, `src/${name}.ts`), `export const ${name} = 1\n`)
      writeFileSync(join(root, `test/${name}.test.ts`), `// ${name}\n`)
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
    initRepository(root)
    const options = {
      files: ['test/**/*.test.ts'],
      log: false,
      root,
      runner: 'deleted',
    }

    const recording = new TiaCore(options)
    await recording.prepare()
    expect(
      await recording.commit(
        [observation('a'), observation('b')],
        ['test/a.test.ts', 'test/b.test.ts'],
      ),
    ).not.toBeNull()

    rmSync(join(root, 'test/b.test.ts'))
    const replaying = new TiaCore(options)
    const plan = await replaying.prepare()

    expect(plan.mode).toBe('replay')
    expect(plan.replayedTests).toBe(1)
    expect(replaying.replayedResults().map((result) => result.id)).toEqual([
      'a-case',
    ])
    expect(Object.keys(plan.graph?.results ?? {})).toEqual(['a-case'])
  })
})
