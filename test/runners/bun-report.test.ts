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
      // JUnit's <error> is a failed case too (Bun 1.4 itself writes <failure>).
      ['test/a.test.ts:20:errors', 'failed', 'errors'],
    ])
    expect(cases[0]?.duration).toBeCloseTo(12.5)
    expect(cases[2]?.duration).toBe(0)
    expect(cases.every((item) => item.file === 'test/a.test.ts')).toBe(true)
  })

  test('decodes numeric character references, and every reference once', () => {
    const cases = parseBunJunit(
      ROOT,
      [
        '<testcase name="tab&#9;line&#10;return&#13;quote&#x27;&#39;" file="t.test.ts" line="2" />',
        '<testcase name="literal &amp;#10; &amp;lt;b&amp;gt; &amp;amp;" file="t.test.ts" line="3" />',
      ].join('\n'),
    )
    expect(cases.map((item) => [item.id, item.fullName])).toEqual([
      ["t.test.ts:2:tab\tline\nreturn\rquote''", "tab\tline\nreturn\rquote''"],
      [
        't.test.ts:3:literal &#10; &lt;b&gt; &amp;',
        'literal &#10; &lt;b&gt; &amp;',
      ],
    ])
  })

  test('keeps the describe blocks around a case, outermost first, without changing its name or id', () => {
    // Bun nests one <testsuite> per describe block inside the file's suite.
    const xml = `<testsuites name="bun test">
  <testsuite name="test/d.test.ts" file="test/d.test.ts">
    <testcase name="top" classname="" file="test/d.test.ts" line="2" />
    <testsuite name="group &quot;g&quot;" file="test/d.test.ts" line="3">
      <testcase name="inside" classname="group &quot;g&quot;" file="test/d.test.ts" line="4" />
      <testsuite name="inner" file="test/d.test.ts" line="5">
        <testcase name="deep" classname="inner &gt; group &quot;g&quot;" file="test/d.test.ts" line="6">
          <failure type="AssertionError" />
        </testcase>
      </testsuite>
    </testsuite>
    <testcase name="last" classname="" file="test/d.test.ts" line="9" />
  </testsuite>
</testsuites>`
    expect(
      parseBunJunit(ROOT, xml).map((item) => [
        item.id,
        item.fullName,
        item.describes ?? [],
        item.state,
      ]),
    ).toEqual([
      ['test/d.test.ts:2:top', 'top', [], 'passed'],
      ['test/d.test.ts:4:inside', 'inside', ['group "g"'], 'passed'],
      ['test/d.test.ts:6:deep', 'deep', ['group "g"', 'inner'], 'failed'],
      ['test/d.test.ts:9:last', 'last', [], 'passed'],
    ])
  })

  test('rejects a report that is not well-formed XML', () => {
    expect(() =>
      parseBunJunit(
        ROOT,
        '<testsuites><testsuite name="f"><testcase name="a" file="a.test.ts" line="1" /><testcase name="b" fi',
      ),
    ).toThrow('The bun JUnit report is not well-formed XML')
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
