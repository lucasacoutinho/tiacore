import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { CachedTestResult } from '../../src/core/runtime.ts'
import { runPromise } from '../../src/host/runtime.ts'
import {
  observeBunCachedCases,
  observeBunFiles,
  type BunContext,
} from '../../src/runners/bun/observe.ts'

// A stand-in for `bun test`: each run writes the JUnit report and exits with
// the code that scenario.json gives its --test-name-pattern, and logs that
// pattern. A pattern the scenario does not know matches nothing.
const FAKE_BUN = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name) =>
  args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1)
const pattern = option('--test-name-pattern') ?? ''
appendFileSync(join(here, 'calls.log'), JSON.stringify(pattern) + '\\n')
const scenario = JSON.parse(readFileSync(join(here, 'scenario.json'), 'utf8'))
const run = scenario[pattern] ?? { code: 1, output: 'matched 0 tests' }
if (run.xml !== undefined) writeFileSync(option('--reporter-outfile'), run.xml)
const coverage = option('--coverage-dir')
if (coverage !== undefined) writeFileSync(join(coverage, 'lcov.info'), '')
process.stdout.write(run.output ?? '')
process.exitCode = run.code
`

interface Run {
  readonly code: number
  readonly output?: string
  readonly xml?: string
}

const FILE = 'test/x.test.ts'
const MODULE_FAILURE = `module:${FILE}`
const SKIPPED = '<skipped />'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function fakeBun(scenario: Readonly<Record<string, Run>>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tiacore-bun-fake-')))
  directories.push(root)
  const binary = join(root, 'bun.mjs')
  writeFileSync(binary, FAKE_BUN)
  chmodSync(binary, 0o755)
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(scenario))
  writeFileSync(join(root, 'calls.log'), '')
  const context: BunContext = { binary, concurrency: 1, root }
  return {
    calls: (): unknown[] =>
      readFileSync(join(root, 'calls.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line)),
    context,
    file: join(root, FILE),
  }
}

function report(...cases: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test">
  <testsuite name="${FILE}" file="${FILE}">
    ${cases.join('\n    ')}
  </testsuite>
</testsuites>
`
}

function testCase(name: string, line: number, child = ''): string {
  const attributes = `name="${name}" classname="" time="0.001" file="${FILE}" line="${line}"`
  return child === ''
    ? `<testcase ${attributes} />`
    : `<testcase ${attributes}>${child}</testcase>`
}

function group(name: string, line: number, ...cases: string[]): string {
  return `<testsuite name="${name}" file="${FILE}" line="${line}">${cases.join('')}</testsuite>`
}

function cached(name: string, line: number): CachedTestResult {
  return {
    file: FILE,
    fullName: name,
    id: `${FILE}:${line}:${name}`,
    state: 'passed',
  }
}

const NOTHING_MATCHED = 'error: regex "a^" matched 0 tests.'

describe('bun observation of recorded files', () => {
  test('a file whose every case run fails outside the case reports its module failure once', async () => {
    // As when an afterAll hook throws: each case passes, each process fails.
    const bun = fakeBun({
      '^a$': {
        code: 1,
        xml: report(testCase('a', 2), testCase('b', 3, SKIPPED)),
      },
      '^b$': {
        code: 1,
        xml: report(testCase('a', 2, SKIPPED), testCase('b', 3)),
      },
      'a^': {
        code: 1,
        output: NOTHING_MATCHED,
        xml: report(testCase('a', 2, SKIPPED), testCase('b', 3, SKIPPED)),
      },
    })
    const observed = await runPromise(observeBunFiles(bun.context, [bun.file]))
    expect(observed.complete).toBe(true)
    expect(observed.observations.map((item) => item.id)).toEqual([
      MODULE_FAILURE,
    ])
  })

  test('a same-named case at the top level and inside describe are selected independently', async () => {
    const bun = fakeBun({
      '^g same$': {
        code: 0,
        xml: report(
          testCase('same', 2, SKIPPED),
          group('g', 3, testCase('same', 4)),
        ),
      },
      '^same$': {
        code: 0,
        xml: report(
          testCase('same', 2),
          group('g', 3, testCase('same', 4, SKIPPED)),
        ),
      },
      'a^': {
        code: 1,
        output: NOTHING_MATCHED,
        xml: report(
          testCase('same', 2, SKIPPED),
          group('g', 3, testCase('same', 4, SKIPPED)),
        ),
      },
    })
    const observed = await runPromise(observeBunFiles(bun.context, [bun.file]))
    expect(observed.observations.map((item) => [item.id, item.state])).toEqual([
      [`${FILE}:2:same`, 'passed'],
      [`${FILE}:4:g same`, 'passed'],
    ])
  })

  test('a skipped case stays a module failure even when bun exits cleanly', async () => {
    // A describe.skip or describe.todo group makes a run that matches nothing
    // exit 0, with every case reported as a bare <skipped />.
    const everythingSkipped = report(
      group('g', 2, testCase('inside', 3, SKIPPED)),
      group('parked', 5, testCase('later', 6, SKIPPED)),
    )
    const bun = fakeBun({
      '^g inside$': { code: 0, xml: everythingSkipped },
      '^parked later$': { code: 0, xml: everythingSkipped },
      'a^': { code: 0, xml: everythingSkipped },
    })
    const observed = await runPromise(observeBunFiles(bun.context, [bun.file]))
    expect(observed.observations.map((item) => [item.id, item.state])).toEqual([
      [MODULE_FAILURE, 'failed'],
    ])
  })

  test('selects a case named with a numeric character reference by its decoded name', async () => {
    const bun = fakeBun({
      '^tab\there$': { code: 0, xml: report(testCase('tab&#9;here', 2)) },
      'a^': {
        code: 1,
        output: NOTHING_MATCHED,
        xml: report(testCase('tab&#9;here', 2, SKIPPED)),
      },
    })
    const observed = await runPromise(observeBunFiles(bun.context, [bun.file]))
    expect(
      observed.observations.map((item) => [item.id, item.fullName, item.state]),
    ).toEqual([[`${FILE}:2:tab\there`, 'tab\there', 'passed']])
    expect(bun.calls()).toEqual(['a^', '^tab\there$'])
  })
})

describe('bun replay of cached cases', () => {
  test('cases of a file whose processes fail outside the case report its module failure once', async () => {
    const bun = fakeBun({
      '^a$': {
        code: 1,
        xml: report(testCase('a', 2), testCase('b', 3, SKIPPED)),
      },
      '^b$': {
        code: 1,
        xml: report(testCase('a', 2, SKIPPED), testCase('b', 3)),
      },
    })
    const observed = await runPromise(
      observeBunCachedCases(bun.context, [cached('a', 2), cached('b', 3)]),
    )
    expect(observed.complete).toBe(true)
    expect(observed.observations.map((item) => item.id)).toEqual([
      MODULE_FAILURE,
    ])
  })

  test('a case missing from a clean report is a module failure, so its old result is not kept', async () => {
    // Exit 0 although ^gone$ matched nothing, as with a describe.skip group.
    const bun = fakeBun({
      '^gone$': {
        code: 0,
        xml: report(group('parked', 2, testCase('later', 3, SKIPPED))),
      },
    })
    const observed = await runPromise(
      observeBunCachedCases(bun.context, [cached('gone', 5)]),
    )
    expect(observed.observations.map((item) => [item.id, item.state])).toEqual([
      [MODULE_FAILURE, 'failed'],
    ])
  })

  test('a malformed report is a module failure, not a crash', async () => {
    const bun = fakeBun({
      '^a$': {
        code: 0,
        xml: `<testsuites><testsuite name="${FILE}"><testcase name="a" file="${FILE}" line="2" /><testcase name="b" fi`,
      },
    })
    const observed = await runPromise(
      observeBunCachedCases(bun.context, [cached('a', 2)]),
    )
    expect(observed.observations.map((item) => [item.id, item.state])).toEqual([
      [MODULE_FAILURE, 'failed'],
    ])
  })

  test('a passing case is replayed from its own entry, not from a same-named one', async () => {
    const bun = fakeBun({
      '^same$': {
        code: 0,
        xml: report(
          group('g', 2, testCase('same', 3, SKIPPED)),
          testCase('same', 5),
        ),
      },
    })
    const observed = await runPromise(
      observeBunCachedCases(bun.context, [cached('same', 5)]),
    )
    expect(observed.observations.map((item) => [item.id, item.state])).toEqual([
      [`${FILE}:5:same`, 'passed'],
    ])
  })
})
