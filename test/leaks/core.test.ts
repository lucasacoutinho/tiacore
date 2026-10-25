import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { TiaCore, type TiaObservation } from '../../src/engine/core.ts'
import { disposeHost } from '../../src/host/runtime.ts'
import { assertNoLeak } from '../support/leak.ts'

// NF-MEM: one TiaCore per run, as every runner makes it, with the live store,
// git baselines and the verification snapshot writer (a scoped file handle).
// A watch loop or a CI agent makes thousands of these in one process.

const FILES = 12

let root = ''
let snapshots = ''
const saved: Record<string, string | undefined> = {}

const testFiles = Array.from(
  { length: FILES },
  (_, index) => `test/m${index}.test.mjs`,
)

function observations(): TiaObservation[] {
  return testFiles.map((file, index) => ({
    file,
    files: [`src/m${index}.mjs`],
    fullName: `m${index}`,
    id: `${file}::m${index}`,
    state: 'passed',
  }))
}

function git(...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=tiacore',
      '-c',
      'user.email=leak@tiacore.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, stdio: 'ignore' },
  )
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tiacore-core-leak-'))
  snapshots = mkdtempSync(join(tmpdir(), 'tiacore-core-snapshots-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, '.gitignore'), '.tia/\n')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  for (let index = 0; index < FILES; index += 1) {
    writeFileSync(
      join(root, `src/m${index}.mjs`),
      `export const v = ${index}\n`,
    )
    writeFileSync(join(root, testFiles[index] ?? ''), 'export {}\n')
  }
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'baseline')
  for (const [key, value] of Object.entries({
    TIA_FRESH: '',
    TIA_VERIFICATION_DIRECTORY: snapshots,
    TIA_VERIFICATION_PHASE: 'selective',
  })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})

afterAll(async () => {
  await disposeHost()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { force: true, recursive: true })
  rmSync(snapshots, { force: true, recursive: true })
})

describe('TiaCore', () => {
  test('prepare and commit, over and over, retain nothing and leave no handle open', async () => {
    const options = {
      files: testFiles,
      fresh: false,
      log: false,
      root,
      runner: 'leak',
      testFiles,
    }
    // Record once so the loop covers replay planning, the store read and the
    // commit of an unchanged project.
    const first = new TiaCore(options)
    await first.prepare()
    await first.commit(observations(), testFiles)
    const result = await assertNoLeak(
      async () => {
        const core = new TiaCore(options)
        const plan = await core.prepare()
        expect(plan.mode).toBe('replay')
        await core.commit(observations(), testFiles)
      },
      { batches: 3, bytesPerOperation: 65_536, iterations: 12 },
    )
    expect(result.bytesPerOperation).toBeLessThan(65_536)
    // The snapshot writer ran each time and left one file, not a growing set.
    const written = readdirSync(snapshots, { recursive: true }).filter((name) =>
      String(name).endsWith('.json'),
    )
    expect(written).toHaveLength(1)
    expect(existsSync(join(root, '.tia'))).toBe(true)
  }, 180_000)
})
