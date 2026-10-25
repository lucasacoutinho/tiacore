import { describe, expect, test } from 'vitest'

import {
  bunTestId,
  parseBunJunit,
  parseBunLcov,
} from '../../src/runners/bun/report.ts'

const ROOT = '/work/project'

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="5">
    <testcase name="passes &amp; &lt;stays&gt;" classname="test/a.test.ts" time="0.0125" file="test/a.test.ts" line="4" assertions="1" />
    <testcase name="fails &quot;loudly&quot;" classname="test/a.test.ts" time="0.5" file="test/a.test.ts" line="9">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="is skipped" classname="test/a.test.ts" file="test/a.test.ts" line="14">
      <skipped />
    </testcase>
    <testcase name="errors" classname="test/a.test.ts" time="0.1" file="test/a.test.ts" line="20">
      <error type="Error" />
    </testcase>
    <testcase name="no file attribute" classname="x" time="0.1" />
    <testcase name="outside" classname="x" time="0.1" file="../elsewhere.test.ts" line="1" />
  </testsuite>
</testsuites>
`

describe('bun:test JUnit report', () => {
  test('reads cases with root-relative ids, states and durations', () => {
    const cases = parseBunJunit(ROOT, JUNIT)
    expect(cases.map((item) => [item.id, item.state, item.fullName])).toEqual([
      ['test/a.test.ts:4:passes & <stays>', 'passed', 'passes & <stays>'],
      ['test/a.test.ts:9:fails "loudly"', 'failed', 'fails "loudly"'],
      ['test/a.test.ts:14:is skipped', 'skipped', 'is skipped'],
      // An <error> element is not recognised: the case reads as passed.
      ['test/a.test.ts:20:errors', 'passed', 'errors'],
    ])
    expect(cases[0]?.duration).toBeCloseTo(12.5)
    expect(cases[2]?.duration).toBe(0)
    expect(cases.every((item) => item.file === 'test/a.test.ts')).toBe(true)
  })

  test('a missing line defaults to 1 and an unparsable time drops the duration', () => {
    const [only] = parseBunJunit(
      ROOT,
      '<testcase name="x" file="t.test.ts" time="soon"/>',
    )
    expect(only).toEqual({
      file: 't.test.ts',
      fullName: 'x',
      id: 't.test.ts:1:x',
      line: 1,
      state: 'passed',
    })
    expect(bunTestId('a', 2, 'b c')).toBe('a:2:b c')
  })
})

describe('bun:test lcov report', () => {
  test('keeps only project files with an executed line, sorted and unique', () => {
    const lcov = [
      'TN:',
      'SF:src/b.ts',
      'DA:1,0',
      'DA:2,3',
      'end_of_record',
      'TN:',
      'SF:/work/project/src/a.ts',
      'DA:1,1',
      'end_of_record',
      'SF:src/unused.ts',
      'DA:1,0',
      'end_of_record',
      'SF:/work/elsewhere/c.ts',
      'DA:1,5',
      'end_of_record',
      'SF:src/b.ts',
      'DA:9,1',
      'end_of_record',
    ].join('\n')
    expect(parseBunLcov(ROOT, lcov)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})
