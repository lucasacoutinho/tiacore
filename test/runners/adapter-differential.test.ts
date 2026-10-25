import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  tia,
  TIA_TYPESCRIPT_ADAPTER_VERSION,
  type TiaAdapterDefinition,
  type TiaAdapterResult,
} from '../../src/entries/adapter.ts'
import { legacy } from '../support/legacy.ts'
import { initRepository } from '../support/runner-project.ts'

interface LegacyAdapter {
  tia: typeof tia
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-adapter-diff-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  for (const name of ['a', 'b', 'c']) {
    writeFileSync(join(root, `src/${name}.ts`), `export const ${name} = 1\n`)
    writeFileSync(join(root, `test/${name}.test.ts`), `// ${name}\n`)
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, '.gitignore'), '.tia/\n')
  initRepository(root)
  return root
}

function definition(
  executed: string[],
  failing: ReadonlySet<string>,
): TiaAdapterDefinition {
  return {
    apiVersion: TIA_TYPESCRIPT_ADAPTER_VERSION,
    discover: () => ({
      files: ['package.json'],
      fingerprint: 'catalog-1',
      tests: ['c', 'a', 'b'].map((name) => ({
        file: `test/${name}.test.ts`,
        fullName: `${name} case`,
        id: `case:${name}`,
      })),
    }),
    execute: ({ tests }) => {
      executed.push(...tests.map((entry) => `${entry.id}:${entry.source}`))
      return {
        complete: true,
        observations: tests.map((entry) => {
          const name = entry.id.slice('case:'.length)
          return {
            file: entry.file,
            files: [entry.file, `src/${name}.ts`],
            fullName: entry.fullName,
            id: entry.id,
            state: failing.has(entry.id) ? 'failed' : 'passed',
          }
        }),
      }
    },
    features: ['parallelism', 'cached-outcomes'],
    name: 'diff-adapter',
    version: '1.0.0',
  }
}

function shape(result: TiaAdapterResult): object {
  return {
    complete: result.complete,
    executed: result.executedTests.map((entry) => [
      entry.id,
      entry.state,
      entry.files,
    ]),
    graphSaved: result.graphSaved,
    mode: result.plan.mode,
    reason: result.plan.reason,
    replayedTests: result.replayedTests,
    selectedTests: result.selectedTests,
    success: result.success,
    whole: result.plan.wholeTestFiles,
  }
}

// The same scenario through 1.x and 2.0 must select, run and report alike.
describe('adapter against the 1.x oracle', () => {
  test('record, replay, change, failure and repair behave identically', async () => {
    const oracle = await legacy<LegacyAdapter>('entries/adapter.js')
    const sides = [
      { executed: [] as string[], root: project(), tia: oracle.tia },
      { executed: [] as string[], root: project(), tia },
    ]
    const failing = new Set<string>()
    const steps: Array<[string, (root: string) => void]> = [
      ['record', () => {}],
      ['replay', () => {}],
      [
        'change a',
        (root) => writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n'),
      ],
      [
        'edit test b',
        (root) => writeFileSync(join(root, 'test/b.test.ts'), '// edited\n'),
      ],
      ['rerun failure', () => failing.add('case:a')],
      ['repair', () => failing.delete('case:a')],
      ['unknown file', (root) => writeFileSync(join(root, 'notes.txt'), 'x\n')],
    ]

    for (const [label, mutate] of steps) {
      const results: object[] = []
      for (const side of sides) {
        mutate(side.root)
        const result = await side
          .tia(definition(side.executed, failing), {
            fresh: false,
            log: false,
            root: side.root,
          })
          .run()
        results.push(shape(result))
      }
      expect(results[1], label).toEqual(results[0])
    }
    expect(sides[1]?.executed).toEqual(sides[0]?.executed)
  })
})
