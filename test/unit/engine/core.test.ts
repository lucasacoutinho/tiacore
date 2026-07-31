import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { TiaCore } from '../../../src/entries/core.js'
import { readGraph } from '../../../src/engine/state/store.js'

const race = vi.hoisted(() => ({
  contents: '',
  file: '',
}))

vi.mock('../../../src/engine/planning/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/engine/planning/runtime.js')
  >()
  const { writeFileSync: writeDuringPlan } = await import('node:fs')

  return {
    ...actual,
    createRunPlan(
      input: Parameters<typeof actual.createRunPlan>[0],
    ) {
      const plan = actual.createRunPlan(input)
      if (race.file !== '') {
        writeDuringPlan(race.file, race.contents)
      }
      return plan
    },
  }
})

const temporaryDirectories: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-core-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'test/a.test.ts'), 'test("a", () => {})\n')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'tia@example.test'], {
    cwd: root,
  })
  execFileSync('git', ['config', 'user.name', 'TIA'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root })
  return root
}

afterEach(() => {
  race.file = ''
  race.contents = ''
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('runner-neutral TIA core', () => {
  test('plans an exact case from observations supplied by a custom runner', async () => {
    const root = fixture()
    const initial = new TiaCore({
      files: ['test/**/*.test.ts'],
      root,
      runner: 'custom',
    })
    expect((await initial.prepare()).mode).toBe('record')
    await initial.commit(
      [
        {
          file: 'test/a.test.ts',
          files: ['src/a.ts', 'test/a.test.ts'],
          fullName: 'a',
          id: 'custom:a',
          state: 'passed',
        },
      ],
      ['test/a.test.ts'],
    )

    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')
    const replay = new TiaCore({
      files: ['test/**/*.test.ts'],
      root,
      runner: 'custom',
    })
    const plan = await replay.prepare()

    expect(plan.mode).toBe('replay')
    expect(plan.affectedTestIds).toEqual(['custom:a'])
    expect(plan.affectedTests).toEqual(['test/a.test.ts'])
  })

  test('rejects a source write that races with run planning', async () => {
    const root = fixture()
    const initial = new TiaCore({
      files: ['test/**/*.test.ts'],
      root,
      runner: 'custom',
    })
    await initial.prepare()
    await initial.commit(
      [{
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
        fullName: 'a',
        id: 'custom:a',
        state: 'passed',
      }],
      ['test/a.test.ts'],
    )

    race.file = join(root, 'src/a.ts')
    race.contents = 'export const a = 2\n'
    const replay = new TiaCore({
      files: ['test/**/*.test.ts'],
      root,
      runner: 'custom',
    })
    const plan = await replay.prepare()

    expect(plan.mode).toBe('replay')
    await expect(replay.commit([], [])).resolves.toBeNull()
  })

  test('does not select a changed test outside a custom runner inventory', async () => {
    const root = fixture()
    const options = {
      files: ['test/**/*.test.ts'],
      root,
      runner: 'custom',
      testFiles: ['test/**/*.test.ts'],
    }
    const initial = new TiaCore(options)
    await initial.prepare()
    await initial.commit(
      [{
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
        fullName: 'a',
        id: 'custom:a',
        state: 'passed',
      }],
      ['test/a.test.ts'],
    )

    mkdirSync(join(root, 'other'))
    writeFileSync(
      join(root, 'other/unrelated.test.ts'),
      'test("unrelated", () => {})\n',
    )
    const plan = await new TiaCore(options).prepare()

    expect(plan.mode).toBe('replay')
    expect(plan.affectedTests).toEqual([])
    expect(plan.wholeTestFiles).toEqual([])
    expect(plan.replayedTests).toBe(1)
  })

  test('reports the provider and artifact that supplied a baseline', async () => {
    const root = fixture()
    const options = {
      files: ['test/**/*.test.ts'],
      root,
      runner: 'custom',
    }
    const initial = new TiaCore(options)
    await initial.prepare()
    await initial.commit(
      [{
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
        fullName: 'a',
        id: 'custom:a',
        state: 'passed',
      }],
      ['test/a.test.ts'],
    )
    const graph = readGraph(join(root, '.tia/custom'))
    if (graph === null) throw new Error('expected custom graph')
    rmSync(join(root, '.tia'), { force: true, recursive: true })

    const replay = new TiaCore({
      ...options,
      artifactTrust: { allowUnsigned: true },
      artifacts: {
        load: () => ({ graph, id: 'artifact-42' }),
        name: 'fixture registry',
      },
    })
    const plan = await replay.prepare()

    expect(plan.mode).toBe('replay')
    expect(plan.baseline).toMatchObject({
      artifactId: 'artifact-42',
      origin: 'artifact',
      provider: 'fixture registry',
      reason: 'compatible artifact restored',
      source: 'git',
    })
  })
})
