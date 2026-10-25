import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  tia,
  TIA_TYPESCRIPT_ADAPTER_VERSION,
  type TiaAdapterDefinition,
} from '../../src/entries/adapter.ts'
import { initRepository } from '../support/runner-project.ts'

const temporaryDirectories: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-adapter-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'src/value.ts'), 'export const value = 1\n')
  writeFileSync(join(root, 'test/value.test.ts'), '// custom suite\n')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  initRepository(root)
  return root
}

function definition(executions: string[]): TiaAdapterDefinition {
  return {
    apiVersion: TIA_TYPESCRIPT_ADAPTER_VERSION,
    discover: () => ({
      files: ['package.json'],
      tests: [
        {
          file: 'test/value.test.ts',
          fullName: 'custom value case',
          id: 'custom:value',
        },
      ],
    }),
    execute: ({ tests }) => {
      executions.push(...tests.map((selectedTest) => selectedTest.id))
      return {
        complete: true,
        observations: tests.map((selectedTest) => ({
          file: selectedTest.file,
          files: [selectedTest.file, 'src/value.ts'],
          fullName: selectedTest.fullName,
          id: selectedTest.id,
          state: 'passed',
        })),
      }
    },
    features: ['cached-outcomes', 'worktrees'],
    name: 'fixture-adapter',
    version: '1.0.0',
  }
}

const OPTIONS = { fresh: false, log: false } as const

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('TypeScript adapter contract', () => {
  test('records, replays, and selects through the public tia factory', async () => {
    const root = project()
    const executions: string[] = []

    const first = await tia(definition(executions), { ...OPTIONS, root }).run()
    expect(first).toMatchObject({
      complete: true,
      graphSaved: true,
      replayedTests: 0,
      selectedTests: 1,
      success: true,
    })

    const replay = await tia(definition(executions), { ...OPTIONS, root }).run()
    expect(replay).toMatchObject({
      complete: true,
      selectedTests: 0,
      success: true,
    })
    expect(replay.replayedTests).toBeGreaterThanOrEqual(1)

    writeFileSync(join(root, 'src/value.ts'), 'export const value = 2\n')
    const changed = await tia(definition(executions), {
      ...OPTIONS,
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

    await expect(
      tia(adapter, { ...OPTIONS, root }).run(),
    ).resolves.toMatchObject({
      complete: false,
      graph: null,
      graphSaved: false,
      selectedTests: 1,
      success: false,
    })
  })

  test('rejects unsafe names, duplicate ids, and escaping paths', async () => {
    const root = project()
    expect(() =>
      tia({ ...definition([]), name: '../outside' }, { ...OPTIONS, root }),
    ).toThrow('safe lowercase cache key')

    const duplicate = definition([])
    duplicate.discover = () => ({
      tests: [
        { file: 'test/a.test.ts', fullName: 'a', id: 'same' },
        { file: 'test/b.test.ts', fullName: 'b', id: 'same' },
      ],
    })
    await expect(tia(duplicate, { ...OPTIONS, root }).run()).rejects.toThrow(
      'duplicate test ids',
    )

    const escaping = definition([])
    escaping.discover = () => ({
      tests: [{ file: '../outside.test.ts', fullName: 'a', id: 'a' }],
    })
    await expect(tia(escaping, { ...OPTIONS, root }).run()).rejects.toThrow(
      'project-relative',
    )
  })
})

describe('adapter construction', () => {
  // ADAPT-API-02, ADAPT-VALID-01..04
  test('validates the definition eagerly with the 1.x messages', () => {
    const base = definition([])
    const make = (change: object) => () => tia({ ...base, ...change })

    expect(TIA_TYPESCRIPT_ADAPTER_VERSION).toBe(1)
    expect(make({ apiVersion: 2 })).toThrow(
      'unsupported TIA TypeScript adapter version: 2',
    )
    for (const name of ['', 'Upper', '-lead', 'a'.repeat(129), 'sp ace']) {
      expect(make({ name })).toThrow(
        'TIA adapter name must be a safe lowercase cache key',
      )
    }
    expect(() => tia({ ...base, name: 'a'.repeat(128) })).not.toThrow()
    expect(make({ version: '  ' })).toThrow(
      'TIA adapter version must be between 1 and 8192 characters',
    )
    expect(make({ version: 'v'.repeat(8_193) })).toThrow(
      'TIA adapter version must be between 1 and 8192 characters',
    )
    expect(make({ features: ['worktrees', 'worktrees'] })).toThrow(
      'TIA adapter features contain duplicates',
    )
    expect(make({ features: ['telepathy'] })).toThrow(
      'unsupported TIA adapter feature: telepathy',
    )
    // Duplicates are reported before unknown features.
    expect(make({ features: ['telepathy', 'telepathy'] })).toThrow(
      'features contain duplicates',
    )
  })
})

describe('adapter discovery', () => {
  // ADAPT-DISC-01
  test('a failing discover rejects and leaves the cache untouched', async () => {
    const root = project()
    const adapter = definition([])
    adapter.discover = () => {
      throw new Error('discovery exploded')
    }
    await expect(tia(adapter, { ...OPTIONS, root }).run()).rejects.toThrow(
      'discovery exploded',
    )
    expect(existsSync(join(root, '.tia'))).toBe(false)
  })

  // ADAPT-DISC-02, ADAPT-DISC-04
  test.each([
    [
      'a non-array catalog',
      { tests: 'nope' },
      'TIA adapter discovery must return a test array',
    ],
    [
      'a blank id',
      { tests: [{ file: 'a.test.ts', fullName: 'a', id: '  ' }] },
      'TIA adapter test id must be between 1 and 8192 characters',
    ],
    [
      'an over-long name',
      { tests: [{ file: 'a.test.ts', fullName: 'n'.repeat(8_193), id: 'a' }] },
      'TIA adapter test name must be between 1 and 8192 characters',
    ],
    [
      'an empty fingerprint',
      { fingerprint: '', tests: [] },
      'TIA adapter catalog fingerprint is invalid',
    ],
    [
      'a Windows drive path',
      { tests: [{ file: 'C:\\x.test.ts', fullName: 'a', id: 'a' }] },
      'TIA protocol paths must be project-relative',
    ],
  ])('rejects %s', async (_label, catalog, message) => {
    const root = project()
    const adapter = definition([])
    adapter.discover = () => catalog as never
    await expect(tia(adapter, { ...OPTIONS, root }).run()).rejects.toThrow(
      message,
    )
  })

  test('normalizes catalog paths and sorts tests by id', async () => {
    const root = project()
    const seen: string[][] = []
    const adapter = definition([])
    adapter.discover = () => ({
      tests: [
        { file: './test\\b.test.ts', fullName: 'b', id: 'b' },
        { file: 'test/a.test.ts', fullName: 'a', id: 'a' },
        { file: 'test/c.test.ts', fullName: 'c', id: 'Z' },
      ],
    })
    adapter.execute = ({ tests }) => {
      seen.push(tests.map((entry) => `${entry.id}@${entry.file}`))
      return { complete: true, observations: [] }
    }
    const result = await tia(adapter, { ...OPTIONS, root }).run()
    expect(seen).toEqual([
      ['Z@test/c.test.ts', 'a@test/a.test.ts', 'b@test/b.test.ts'],
    ])
    expect(result.complete).toBe(false)
  })
})

const run = async (
  execution: (tests: string[]) => unknown,
  root = project(),
) => {
  const adapter = definition([])
  adapter.execute = ({ tests }) =>
    execution(tests.map((entry) => entry.id)) as never
  return await tia(adapter, { ...OPTIONS, root }).run()
}
const observation = (extra: object = {}) => ({
  file: 'test/value.test.ts',
  files: ['src/value.ts'],
  fullName: 'custom value case',
  id: 'custom:value',
  state: 'passed' as 'failed' | 'passed' | 'skipped',
  ...extra,
})

describe('adapter execution contract', () => {
  // ADAPT-EXEC-02, ADAPT-EXEC-03, ADAPT-EXEC-04
  test.each([
    [
      'a missing completeness flag',
      { observations: [] },
      'TIA adapter execution must declare completeness',
    ],
    [
      'a non-array observation list',
      { complete: true, observations: 'x' },
      'TIA adapter execution must return observations',
    ],
    [
      'an invalid state',
      { complete: true, observations: [observation({ state: 'exploded' })] },
      'TIA adapter observation has an invalid state: custom:value',
    ],
    [
      'a negative duration',
      { complete: true, observations: [observation({ duration: -1 })] },
      'TIA adapter observation has an invalid duration: custom:value',
    ],
    [
      'a NaN duration',
      { complete: true, observations: [observation({ duration: Number.NaN })] },
      'TIA adapter observation has an invalid duration: custom:value',
    ],
    [
      'duplicate observation ids',
      { complete: true, observations: [observation(), observation()] },
      'TIA adapter execution returned duplicate observation ids',
    ],
    [
      'an escaping observation file',
      { complete: true, observations: [observation({ file: '../x' })] },
      'project-relative',
    ],
  ])('rejects %s before any commit', async (_label, execution, message) => {
    const root = project()
    await expect(run(() => execution, root)).rejects.toThrow(message)
    expect(existsSync(join(root, '.tia/fixture-adapter/state.json'))).toBe(
      false,
    )
  })

  // ADAPT-COMMIT-04, ADAPT-RES-02
  test('commits failed observations, which then rerun on the next plan', async () => {
    const root = project()
    const result = await run(
      () => ({
        complete: true,
        observations: [observation({ state: 'failed' })],
      }),
      root,
    )
    expect(result).toMatchObject({
      complete: true,
      graphSaved: true,
      success: false,
    })
    const next = await run(
      (ids) => ({
        complete: true,
        observations: ids.map((id) => observation({ id })),
      }),
      root,
    )
    expect(next.plan.affectedTestIds).toEqual(['custom:value'])
    expect(next.selectedTests).toBe(1)
    expect(next.success).toBe(true)
  })

  // ADAPT-COMMIT-02: no cross-check of ids against the catalog.
  test('accepts and commits observations for tests that were not selected', async () => {
    const result = await run(() => ({
      complete: true,
      observations: [
        observation(),
        observation({
          file: 'test/extra.test.ts',
          fullName: 'extra',
          id: 'extra',
        }),
      ],
    }))
    expect(result.graphSaved).toBe(true)
    expect(result.executedTests.map((item) => item.id)).toEqual([
      'custom:value',
      'extra',
    ])
  })

  // ADAPT-EXEC-01, ADAPT-COMMIT-03, ADAPT-RES-02
  test('passes only the selection and reruns just what changed', async () => {
    const root = project()
    const contexts: Array<{
      mode: string
      tests: string[]
      whole: string[]
    }> = []
    const adapter = definition([])
    adapter.execute = ({ plan, tests, wholeTestFiles }) => {
      contexts.push({
        mode: plan.mode,
        tests: tests.map((entry) => `${entry.id}:${entry.source}`),
        whole: wholeTestFiles,
      })
      return {
        complete: true,
        observations: tests.map((entry) => observation({ id: entry.id })),
      }
    }
    await tia(adapter, { ...OPTIONS, root }).run()
    const quiet = await tia(adapter, { ...OPTIONS, root }).run()
    expect(quiet.selectedTests).toBe(0)
    expect(quiet.replayedTests).toBe(1)
    writeFileSync(join(root, 'test/value.test.ts'), '// edited\n')
    const edited = await tia(adapter, { ...OPTIONS, root }).run()

    expect(contexts).toEqual([
      {
        mode: 'record',
        tests: ['custom:value:catalog'],
        whole: ['test/value.test.ts'],
      },
      {
        mode: 'replay',
        tests: ['custom:value:catalog'],
        whole: ['test/value.test.ts'],
      },
    ])
    expect(edited.plan.wholeTestFiles).toEqual(['test/value.test.ts'])
  })

  // ADAPT-PLAN-03
  test('selects an affected test missing from the catalog from the stored graph', async () => {
    const root = project()
    let catalogIds = ['custom:value']
    const seen: string[][] = []
    const adapter = definition([])
    adapter.discover = () => ({
      files: ['package.json'],
      tests: catalogIds.map((id) => ({
        file: 'test/value.test.ts',
        fullName: `case ${id}`,
        id,
      })),
    })
    adapter.execute = ({ tests }) => {
      seen.push(tests.map((entry) => `${entry.id}:${entry.source}`))
      return {
        complete: true,
        observations: tests.map((entry) =>
          observation({
            fullName: entry.fullName,
            id: entry.id,
            state: seen.length === 1 ? 'failed' : 'passed',
          }),
        ),
      }
    }
    await tia(adapter, { ...OPTIONS, root }).run()
    catalogIds = ['custom:renamed']
    await tia(adapter, { ...OPTIONS, root }).run()
    expect(seen[0]).toEqual(['custom:value:catalog'])
    expect(seen[1]).toContain('custom:value:baseline')
  })

  // ADAPT-FEAT-01
  test('a changed feature list invalidates the stored graph', async () => {
    const root = project()
    await tia(definition([]), { ...OPTIONS, root }).run()
    const changed = await tia(
      { ...definition([]), features: ['cached-outcomes'] },
      { ...OPTIONS, root },
    ).run()
    expect(changed.plan).toMatchObject({
      mode: 'record',
      reason: 'project structure changed',
    })
  })

  // ADAPT-COMMIT-05
  test('an empty selection on a complete run still commits', async () => {
    const root = project()
    await tia(definition([]), { ...OPTIONS, root }).run()
    const quiet = await tia(definition([]), { ...OPTIONS, root }).run()
    expect(quiet).toMatchObject({
      complete: true,
      graphSaved: true,
      selectedTests: 0,
      success: true,
    })
  })

  // ADAPT-OPT-02
  test('prints one summary line unless log is false', async () => {
    const root = project()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await tia(definition([]), { fresh: false, root }).run()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toMatch(
      /^TIA fixture-adapter: .*; 1 selected, 0 replayed\.$/u,
    )
    log.mockClear()
    await tia(definition([]), { ...OPTIONS, root }).run()
    expect(log).not.toHaveBeenCalled()
  })
})
