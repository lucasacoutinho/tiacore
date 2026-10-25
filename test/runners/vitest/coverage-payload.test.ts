import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { expandCoverageHits } from '../../../src/engine/state/coverage.ts'
import {
  cleanupProjects,
  createProject,
  readGraph,
  runVitest,
} from '../../support/integration-project.ts'

afterEach(() => {
  cleanupProjects()
})

const SOURCE_FILES = 6
const FUNCTIONS = 60
const TEST_FILES = 4
const TESTS = 5

interface Probe {
  moduleMetaBytes: number[]
  retainedTiaKeys: string[]
  testMetaBytes: number[]
}

// Each file gets a different number of functions, so each has its own
// content-addressed coverage map.
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
      (_, module) =>
        `expect(m${module}.f${(file + index) % FUNCTIONS}(1)).toBeTypeOf('number')`,
    ).join('\n  ')
  const tests = Array.from(
    { length: TESTS },
    (_, index) => `test('case ${index}', () => {\n  ${calls(index)}\n})\n`,
  ).join('\n')
  return `import { expect, test } from 'vitest'\n${imports}\n\n${tests}`
}

const probeReporter = `import { writeFileSync } from 'node:fs'

const testMetaBytes = []
const moduleMetaBytes = []

export default class Probe {
  onTestCaseResult(testCase) {
    testMetaBytes.push(JSON.stringify(testCase.meta()).length)
  }
  onTestModuleEnd(module) {
    moduleMetaBytes.push(JSON.stringify(module.meta()).length)
  }
  onTestRunEnd(modules) {
    const retainedTiaKeys = []
    for (const module of modules) {
      const metas = [module.meta(), ...[...module.children.allTests()].map((test) => test.meta())]
      for (const meta of metas) {
        retainedTiaKeys.push(...Object.keys(meta).filter((key) => key.startsWith('__tiacore')))
      }
    }
    writeFileSync('probe.json', JSON.stringify({ moduleMetaBytes, retainedTiaKeys, testMetaBytes }))
  }
}
`

describe('Vitest coverage payloads', () => {
  test('sends advanced counters only and releases task metadata after recording', async () => {
    const extraFiles: Record<string, string> = {
      '.gitignore': 'node_modules\n.tia/\nprobe.json\n',
      'probe-reporter.js': probeReporter,
    }
    for (let index = 0; index < SOURCE_FILES; index += 1) {
      extraFiles[`src/m${index}.ts`] = sourceFile(index)
    }
    for (let file = 0; file < TEST_FILES; file += 1) {
      extraFiles[`test/t${file}.test.ts`] = testFile(file)
    }
    const root = createProject({
      extraFiles,
      include: "['test/t*.test.ts']",
      testConfig: "reporters: ['default', './probe-reporter.js'],",
    })

    const run = runVitest(root, ['run'], 60_000)
    expect(run.status, run.output).toBe(0)

    const probe = JSON.parse(
      readFileSync(join(root, 'probe.json'), 'utf8'),
    ) as Probe
    expect(probe.testMetaBytes).toHaveLength(TEST_FILES * TESTS)
    expect(probe.retainedTiaKeys).toEqual([])

    const graph = await readGraph(root)
    const testCoverage = Object.values(graph.testCoverage)
    expect(testCoverage).toHaveLength(TEST_FILES * TESTS)
    for (const coverage of testCoverage) {
      expect(Object.keys(coverage).sort()).toEqual(
        Array.from({ length: SOURCE_FILES }, (_, index) => `src/m${index}.ts`),
      )
      for (const [path, hits] of Object.entries(coverage)) {
        const file = expandCoverageHits(
          graph.coverageMaps[hits.map]!,
          path,
          hits,
        )
        expect(Object.keys(file.s)).toEqual(Object.keys(file.statementMap))
        expect(Object.keys(file.f)).toEqual(Object.keys(file.fnMap))
        expect(Object.keys(file.b)).toEqual(Object.keys(file.branchMap))
        expect(Object.values(file.f).some((count) => count > 0)).toBe(true)
      }
    }
    expect(Object.keys(graph.coverageMaps)).toHaveLength(SOURCE_FILES)

    const staticMapBytes = Math.min(
      ...testCoverage.map(
        (coverage) =>
          JSON.stringify(
            Object.values(coverage).map((hits) => graph.coverageMaps[hits.map]),
          ).length,
      ),
    )
    const largestPayload = Math.max(
      ...probe.testMetaBytes,
      ...probe.moduleMetaBytes,
    )
    expect(largestPayload * 20).toBeLessThan(staticMapBytes)
  })
})
