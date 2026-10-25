import { describe, expect, test } from 'vitest'

import { auditVerificationSelection } from '../../src/assurance/verify/selection.ts'
import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import { exampleGraph, exampleSnapshot } from './support.ts'

// Two test files; b has per-test edges for one of its two tests only.
function suite(): TiaRuntimeGraph {
  const graph = exampleGraph()
  graph.results['b one'] = {
    file: 'test/b.test.ts',
    fullName: 'b one',
    id: 'b one',
    state: 'passed',
  }
  graph.results['b two'] = {
    file: 'test/b.test.ts',
    fullName: 'b two',
    id: 'b two',
    state: 'passed',
  }
  graph.results['module:test/c.test.ts'] = {
    file: 'test/c.test.ts',
    fullName: 'c',
    id: 'module:test/c.test.ts',
    state: 'failed',
  }
  graph.results.skipped = {
    file: 'test/b.test.ts',
    fullName: 'skipped',
    id: 'skipped',
    state: 'skipped',
  }
  graph.edges['test/b.test.ts'] = ['src/b.ts', 'test/b.test.ts']
  graph.testEdges['b one'] = {
    file: 'test/b.test.ts',
    files: ['src/b.ts', 'test/b.test.ts'],
  }
  return graph
}

function expected(
  changedFiles: string[],
  options: {
    mode?: 'record' | 'replay'
    selective?: TiaRuntimeGraph
    whole?: string[]
    executed?: string[]
  } = {},
) {
  const selective = exampleSnapshot('selective', options.selective ?? suite())
  selective.plan.changedFiles = changedFiles
  selective.plan.mode = options.mode ?? 'replay'
  selective.plan.wholeTestFiles = options.whole ?? []
  selective.executedTestIds = options.executed ?? []
  return auditVerificationSelection(selective, exampleSnapshot('full', suite()))
}

describe('verification selection audit', () => {
  test('ignores skipped results and module results', () => {
    expect(expected(['package.json']).expectedTestIds).toEqual([
      'b one',
      'b two',
      'case',
    ])
  })

  test('a dependency change selects only the tests that depend on it', () => {
    expect(expected(['src/b.ts']).expectedTestIds).toEqual(['b one', 'b two'])
    expect(expected(['src/example.ts']).expectedTestIds).toEqual(['case'])
  })

  test('a record-mode selective plan requires every runnable test', () => {
    expect(expected([], { mode: 'record' }).expectedTestIds).toHaveLength(3)
  })

  test('a changed test file requires all of its runnable tests', () => {
    expect(expected(['test/b.test.ts']).expectedTestIds).toEqual([
      'b one',
      'b two',
    ])
  })

  test('a previously failed selective result must run again', () => {
    const selective = suite()
    selective.results['b one']!.state = 'failed'
    // b two has no per-test edges, so the planner reruns the whole file.
    expect(expected([], { selective }).expectedTestIds).toEqual([
      'b one',
      'b two',
    ])
    selective.testEdges['b two'] = { file: 'test/b.test.ts', files: [] }
    expect(expected([], { selective }).expectedTestIds).toEqual(['b one'])
  })

  test('whole-file fallbacks of the selective plan are required', () => {
    expect(expected([], { whole: ['test/b.test.ts'] }).expectedTestIds).toEqual(
      ['b one', 'b two'],
    )
  })

  test('executed and unnecessary tests are restricted to the full run', () => {
    const result = expected(['src/example.ts'], {
      executed: ['case', 'b one', 'gone', 'skipped'],
    })
    expect(result.executedTestIds).toEqual(['b one', 'case'])
    expect(result.unnecessaryTestIds).toEqual(['b one'])
    expect(result.precision).toBe(0.5)
    expect(result.falseNegativeRate).toBe(0)
  })

  test('changed files are reported sorted', () => {
    expect(expected(['src/b.ts', 'src/a.ts']).changedFiles).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
  })
})
