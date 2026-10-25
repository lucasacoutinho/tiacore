import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createProject,
  git,
  readGraph,
  runVitest,
} from '../../helpers/integration-project.js'

afterEach(() => {
  cleanupProjects()
})

const SOURCE_FILES = 34
const FUNCTIONS = 48
const TEST_FILES = 20
const TESTS = 32
const RUNTIME_STORE_CAPACITY = 64 * 20 * 1024 * 1024

function sourceFile(index: number): string {
  return Array.from(
    { length: FUNCTIONS + index },
    (_, fn) => `export function f${fn}(value: number): number {
  if (value > ${fn}) {
    return value % 2 === 0 ? value + ${fn} : value - ${fn}
  }
  return [value, ${index}].map((item) => item * 2).length
}
`,
  ).join('\n')
}

function testFile(file: number): string {
  const imports = Array.from(
    { length: SOURCE_FILES },
    (_, index) => `import * as m${index} from '../src/m${index}'`,
  ).join('\n')
  const calls = (index: number): string =>
    Array.from(
      { length: SOURCE_FILES },
      (_, module) => `m${module}.f${(file + index) % FUNCTIONS}(${index})`,
    ).join(' + ')
  const tests = Array.from(
    { length: TESTS },
    (_, index) =>
      `test('case ${index}', () => {\n  expect(${calls(index)}).toBeTypeOf('number')\n})\n`,
  ).join('\n')
  return `import { expect, test } from 'vitest'\n${imports}\n\n${tests}`
}

function storedBytes(root: string): number {
  const objects = join(root, '.tia/objects')
  return readdirSync(objects).reduce(
    (total, name) => total + statSync(join(objects, name)).size,
    0,
  )
}

describe('Vitest coverage at scale', () => {
  test('records and replays a graph whose per-test maps exceed the old store capacity', () => {
    const extraFiles: Record<string, string> = {}
    for (let index = 0; index < SOURCE_FILES; index += 1) {
      extraFiles[`src/m${index}.ts`] = sourceFile(index)
    }
    for (let file = 0; file < TEST_FILES; file += 1) {
      extraFiles[`test/t${file}.test.ts`] = testFile(file)
    }
    const root = createProject({
      extraFiles,
      include: "['test/t*.test.ts']",
      pluginOptions:
        "{ log: true, coverage: { reporters: [['json', { file: 'coverage-final.json' }]] } }",
    })
    // The heap cap bounds both Vitest's main process and its workers; the
    // previous format retained full maps per test and could not finish here.
    const environment = { NODE_OPTIONS: '--max-old-space-size=768' }

    const recorded = runVitest(root, ['run'], 240_000, environment)
    expect(recorded.status, recorded.output).toBe(0)
    expect(recorded.output).toContain('TIA graph saved')

    const graph = readGraph(root)
    const tests = Object.keys(graph.testCoverage).length
    expect(tests).toBe(TEST_FILES * TESTS)
    expect(Object.keys(graph.coverageMaps)).toHaveLength(SOURCE_FILES)
    for (const record of Object.values(graph.testCoverage)) {
      expect(Object.keys(record)).toHaveLength(SOURCE_FILES)
    }

    const mapBytes = Object.fromEntries(
      Object.entries(graph.coverageMaps).map(([id, map]) => [
        id,
        JSON.stringify(map).length,
      ]),
    )
    const previousFormatLowerBound = Object.values(graph.testCoverage).reduce(
      (total, record) =>
        total +
        Object.values(record).reduce(
          (sum, hits) => sum + (mapBytes[hits.map] ?? 0),
          0,
        ),
      0,
    )
    expect(previousFormatLowerBound).toBeGreaterThan(RUNTIME_STORE_CAPACITY)
    const recordedBytes = storedBytes(root)
    expect(recordedBytes / tests).toBeLessThan(32 * 1024)

    const coverage = JSON.parse(
      readFileSync(join(root, 'coverage/coverage-final.json'), 'utf8'),
    ) as Record<string, { f: Record<string, number> }>
    expect(Object.keys(coverage)).toHaveLength(SOURCE_FILES)

    writeFileSync(join(root, 'test/t3.test.ts'), `${testFile(3)}\n// changed\n`)
    git(root, ['commit', '-qam', 'change one suite'])

    const replay = runVitest(root, ['run'], 240_000, environment)
    expect(replay.status, replay.output).toBe(0)
    expect(replay.output).toContain(
      `${(TEST_FILES - 1) * TESTS} cached test results`,
    )
    expect(
      JSON.parse(
        readFileSync(join(root, 'coverage/coverage-final.json'), 'utf8'),
      ),
    ).toEqual(coverage)
    expect(Object.keys(readGraph(root).testCoverage)).toHaveLength(tests)
  }, 600_000)
})
