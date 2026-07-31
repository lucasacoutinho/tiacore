import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  tia,
  TIA_TYPESCRIPT_ADAPTER_VERSION,
  type TiaAdapterDefinition,
} from '../../../src/entries/adapter.js'

const temporaryDirectories: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-adapter-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'src/value.ts'), 'export const value = 1\n')
  writeFileSync(join(root, 'test/value.test.ts'), '// custom suite\n')
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

function definition(executions: string[]): TiaAdapterDefinition {
  return {
    apiVersion: TIA_TYPESCRIPT_ADAPTER_VERSION,
    discover: () => ({
      files: ['package.json'],
      tests: [{
        file: 'test/value.test.ts',
        fullName: 'custom value case',
        id: 'custom:value',
      }],
    }),
    execute: ({ tests }) => {
      executions.push(...tests.map((test) => test.id))
      return {
        complete: true,
        observations: tests.map((test) => ({
          file: test.file,
          files: [test.file, 'src/value.ts'],
          fullName: test.fullName,
          id: test.id,
          state: 'passed',
        })),
      }
    },
    features: ['cached-outcomes', 'worktrees'],
    name: 'fixture-adapter',
    version: '1.0.0',
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('TypeScript adapter contract', () => {
  test('records, replays, and selects through the public tia factory', async () => {
    const root = project()
    const executions: string[] = []

    const first = await tia(definition(executions), {
      fresh: false,
      log: false,
      root,
    }).run()
    expect(first).toMatchObject({
      complete: true,
      graphSaved: true,
      replayedTests: 0,
      selectedTests: 1,
      success: true,
    })

    const replay = await tia(definition(executions), {
      fresh: false,
      log: false,
      root,
    }).run()
    expect(replay).toMatchObject({
      complete: true,
      selectedTests: 0,
      success: true,
    })
    expect(replay.replayedTests).toBeGreaterThanOrEqual(1)

    writeFileSync(join(root, 'src/value.ts'), 'export const value = 2\n')
    const changed = await tia(definition(executions), {
      fresh: false,
      log: false,
      root,
    }).run()
    expect(changed.plan.affectedTestIds).toEqual(['custom:value'])
    expect(changed.selectedTests).toBe(1)
    expect(executions).toEqual(['custom:value', 'custom:value'])
  })

  test('does not commit incomplete execution evidence', async () => {
    const root = project()
    const adapter = definition([])
    adapter.execute = () => ({ complete: true, observations: [] })

    await expect(tia(adapter, {
      fresh: false,
      log: false,
      root,
    }).run()).resolves.toMatchObject({
      complete: false,
      graph: null,
      graphSaved: false,
      selectedTests: 1,
      success: false,
    })
  })

  test('rejects unsafe names, duplicate ids, and escaping paths', async () => {
    const root = project()
    expect(() => tia({
      ...definition([]),
      name: '../outside',
    }, { fresh: false, root })).toThrow('safe lowercase cache key')

    const duplicate = definition([])
    duplicate.discover = () => ({
      tests: [
        { file: 'test/a.test.ts', fullName: 'a', id: 'same' },
        { file: 'test/b.test.ts', fullName: 'b', id: 'same' },
      ],
    })
    await expect(tia(duplicate, { fresh: false, root }).run()).rejects.toThrow(
      'duplicate test ids',
    )

    const escaping = definition([])
    escaping.discover = () => ({
      tests: [{ file: '../outside.test.ts', fullName: 'a', id: 'a' }],
    })
    await expect(tia(escaping, { fresh: false, root }).run()).rejects.toThrow(
      'project-relative',
    )
  })
})
