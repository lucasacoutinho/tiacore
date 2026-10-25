import { describe, expect, test } from 'vitest'

import { compareProtocolSnapshots } from '../../src/assurance/verify/protocol-compare.ts'
import {
  accuracyReceipt,
  comparePhases,
  performanceReceipt,
  phaseResult,
} from '../../src/assurance/verify/receipt.ts'
import { readSnapshot } from '../../src/assurance/verify/snapshot-read.ts'
import {
  exampleSnapshot,
  protocolGraph,
  protocolPlan,
  protocolSnapshot,
  SUITE_A,
  SUITE_B,
} from './support.ts'

const selectiveOf = (changed: string[], selected: string[]) =>
  protocolSnapshot('selective', {
    executedTestIds: selected,
    plan: protocolPlan(
      selected.length === 0 ? 'skip' : 'selective',
      selected,
      changed,
    ),
    suiteOutcomes: Object.fromEntries(selected.map((id) => [id, 'passed'])),
  })

describe('suite-granular verification', () => {
  test('verifies a selective phase that ran exactly the suites the change reached', () => {
    const result = compareProtocolSnapshots(
      protocolSnapshot('selective'),
      protocolSnapshot('full'),
    )
    expect(result).toEqual({
      issues: [],
      runner: 'k6:.tia/k6/graph.json',
      selection: {
        changedFiles: ['shared/util.js'],
        executedTestIds: [SUITE_A],
        expectedTestIds: [SUITE_A],
        falseNegativeRate: 0,
        missedTestIds: [],
        precision: 1,
        unnecessaryTestIds: [],
      },
      unit: 'suite',
      verified: true,
    })
  })

  test('fails a selective phase that skipped a suite the change reached', () => {
    const result = compareProtocolSnapshots(
      selectiveOf(['shared/util.js'], []),
      protocolSnapshot('full'),
    )
    expect(result.verified).toBe(false)
    expect(result.issues).toEqual([
      {
        code: 'selection-miss',
        message: `selective phase missed 1 required test: ${SUITE_A}`,
        runner: 'k6:.tia/k6/graph.json',
      },
    ])
    expect(result.selection).toMatchObject({
      expectedTestIds: [SUITE_A],
      falseNegativeRate: 1,
      missedTestIds: [SUITE_A],
    })
  })

  test('requires every suite for a change the graph does not know', () => {
    const result = compareProtocolSnapshots(
      selectiveOf(['docs/readme.md'], [SUITE_A]),
      protocolSnapshot('full'),
    )
    expect(result.selection?.missedTestIds).toEqual([SUITE_B])
  })

  test('requires every suite for a structural change', () => {
    const result = compareProtocolSnapshots(
      selectiveOf(['package.json'], [SUITE_A]),
      protocolSnapshot('full'),
    )
    expect(result.selection?.expectedTestIds).toEqual([SUITE_A, SUITE_B])
  })

  test('requires every suite when the selective phase fell back to a full plan', () => {
    const selective = protocolSnapshot('selective', {
      executedTestIds: [SUITE_A],
      plan: protocolPlan('full', [SUITE_A, SUITE_B]),
    })
    expect(
      compareProtocolSnapshots(selective, protocolSnapshot('full')).selection
        ?.missedTestIds,
    ).toEqual([SUITE_B])
  })

  test('requires the suites a suite depends on to run with it', () => {
    const graph = protocolGraph()
    graph.suites = graph.suites.map((suite) =>
      suite.id === SUITE_A ? { ...suite, dependsOn: [SUITE_B] } : suite,
    )
    const result = compareProtocolSnapshots(
      protocolSnapshot('selective', { graph }),
      protocolSnapshot('full', { graph }),
    )
    expect(result.selection).toMatchObject({
      expectedTestIds: [SUITE_A, SUITE_B],
      missedTestIds: [SUITE_B],
    })
  })

  test('uses the selective evidence the full graph no longer has', () => {
    const full = protocolSnapshot('full')
    full.graph.observations = full.graph.observations.filter(
      (item) => item.source !== 'shared/util.js',
    )
    const result = compareProtocolSnapshots(
      selectiveOf(['shared/util.js'], []),
      full,
    )
    expect(result.selection?.expectedTestIds).toEqual([SUITE_A])
    expect(result.issues.map((item) => item.code)).toContain('selection-miss')
  })

  test('uses the full evidence the selective graph did not have', () => {
    const selective = selectiveOf(['shared/extra.js'], [])
    const full = protocolSnapshot('full')
    full.graph.observations.push({
      confidence: 'exact',
      kind: 'import',
      source: 'shared/extra.js',
      suiteId: SUITE_B,
    })
    full.graph.observations.sort((left, right) =>
      `${left.suiteId}${left.source}` < `${right.suiteId}${right.source}`
        ? -1
        : 1,
    )
    const result = compareProtocolSnapshots(selective, full)
    expect(result.selection?.missedTestIds).toEqual([SUITE_B])
    expect(result.issues.map((item) => item.code)).toContain(
      'dependency-mismatch',
    )
  })

  test('a suite outside the full phase plan is not owed', () => {
    const lane = [SUITE_A]
    const result = compareProtocolSnapshots(
      protocolSnapshot('selective', {
        plan: protocolPlan('selective', [SUITE_A], ['shared/util.js'], lane),
      }),
      protocolSnapshot('full', {
        executedTestIds: lane,
        plan: protocolPlan('full', lane, [], lane),
        suiteOutcomes: { [SUITE_A]: 'passed' },
      }),
    )
    expect(result.selection?.expectedTestIds).toEqual([SUITE_A])
    expect(result.verified).toBe(true)
  })

  test('a suite the selective phase skipped stands for the baseline pass', () => {
    const full = protocolSnapshot('full', {
      suiteOutcomes: { [SUITE_A]: 'passed', [SUITE_B]: 'failed' },
    })
    const result = compareProtocolSnapshots(protocolSnapshot('selective'), full)
    expect(result.verified).toBe(false)
    expect(result.issues.map((item) => item.code)).toEqual(['outcome-mismatch'])
    expect(result.selection?.missedTestIds).toEqual([])
  })

  test('a suite that ran in both phases must end the same way', () => {
    const selective = protocolSnapshot('selective', {
      suiteOutcomes: { [SUITE_A]: 'failed' },
    })
    const result = compareProtocolSnapshots(selective, protocolSnapshot('full'))
    expect(result.issues.map((item) => item.code)).toEqual(['outcome-mismatch'])
  })

  test('matching failures verify, like they do for tests', () => {
    const failed = { [SUITE_A]: 'failed' as const }
    const result = compareProtocolSnapshots(
      protocolSnapshot('selective', { success: false, suiteOutcomes: failed }),
      protocolSnapshot('full', {
        success: false,
        suiteOutcomes: { ...failed, [SUITE_B]: 'passed' },
      }),
    )
    expect(result.verified).toBe(true)
  })

  test('an outcome the run could not attribute never verifies', () => {
    const both = {
      [SUITE_A]: 'unknown' as const,
      [SUITE_B]: 'unknown' as const,
    }
    const result = compareProtocolSnapshots(
      protocolSnapshot('selective', {
        suiteOutcomes: { [SUITE_A]: 'unknown' },
      }),
      protocolSnapshot('full', { suiteOutcomes: both }),
    )
    expect(result.issues.map((item) => item.code)).toEqual(['outcome-mismatch'])
    const missing = compareProtocolSnapshots(
      protocolSnapshot('selective', { suiteOutcomes: {} }),
      protocolSnapshot('full'),
    )
    expect(missing.issues.map((item) => item.code)).toEqual([
      'outcome-mismatch',
    ])
  })

  test('different dependency evidence fails', () => {
    const full = protocolSnapshot('full')
    full.graph.observations.pop()
    const result = compareProtocolSnapshots(protocolSnapshot('selective'), full)
    expect(result.issues.map((item) => item.code)).toContain(
      'dependency-mismatch',
    )
  })

  test('an incomplete graph fails in either phase', () => {
    const selective = protocolSnapshot('selective')
    selective.graph.complete = false
    const result = compareProtocolSnapshots(selective, protocolSnapshot('full'))
    expect(result.issues).toContainEqual({
      code: 'incomplete-graph',
      message: 'selective phase produced an incomplete graph',
      runner: 'k6:.tia/k6/graph.json',
    })
  })

  test('a full phase that did not run its whole plan proves nothing', () => {
    const result = compareProtocolSnapshots(
      protocolSnapshot('selective'),
      protocolSnapshot('full', {
        executedTestIds: [SUITE_A],
        suiteOutcomes: { [SUITE_A]: 'passed' },
      }),
    )
    expect(result.verified).toBe(false)
    expect(result.issues).toContainEqual({
      code: 'incomplete-graph',
      message: `full phase did not run 1 suite of its plan: ${SUITE_B}`,
      runner: 'k6:.tia/k6/graph.json',
    })
  })
})

describe('suite-granular receipts', () => {
  test('a protocol full plan is a fallback and its cached suites are replayed', () => {
    const selective = {
      duration: 1,
      snapshots: [
        protocolSnapshot('selective', {
          executedTestIds: [SUITE_A, SUITE_B],
          plan: protocolPlan('full', [SUITE_A, SUITE_B]),
        }),
      ],
      status: 0,
    }
    const full = {
      duration: 2,
      snapshots: [protocolSnapshot('full')],
      status: 0,
    }
    expect(performanceReceipt(selective, full)).toMatchObject({
      fallbacks: [
        {
          reason: 'policy requires a full run',
          runner: 'k6:.tia/k6/graph.json',
        },
      ],
      fullExecutedTests: 2,
      selectiveExecutedTests: 2,
      selectiveReplayedTests: 0,
    })
    expect(phaseResult(selective).metrics).toEqual([
      {
        executedTests: 2,
        mode: 'record',
        reason: 'policy requires a full run',
        replayedTests: 0,
        runner: 'k6:.tia/k6/graph.json',
      },
    ])
    const partial = {
      duration: 1,
      snapshots: [protocolSnapshot('selective')],
      status: 0,
    }
    expect(performanceReceipt(partial, full)).toMatchObject({
      executionReduction: 0.5,
      fallbacks: [],
      selectiveReplayedTests: 1,
    })
  })

  test('counts suites in the accuracy of a command that runs several kinds of runner', () => {
    const phases = comparePhases(
      [
        protocolSnapshot('selective'),
        exampleSnapshot('selective', undefined, 'vitest:fixture'),
      ],
      [
        protocolSnapshot('full'),
        exampleSnapshot('full', undefined, 'vitest:fixture'),
      ],
    )
    expect(phases.issues).toEqual([])
    expect(phases.runners.map((runner) => runner.unit)).toEqual([
      'suite',
      undefined,
    ])
    expect(accuracyReceipt(phases.runners)).toMatchObject({
      executedTests: 1,
      expectedTests: 1,
      missedTests: 0,
    })
  })

  test('a runner cannot change kind between phases', () => {
    const phases = comparePhases(
      [protocolSnapshot('selective', {}, 'x')],
      [exampleSnapshot('full', undefined, 'x')],
    )
    expect(phases.issues).toEqual([
      {
        code: 'snapshot-invalid',
        message: 'x wrote a different kind of snapshot in each phase',
        runner: 'x',
      },
    ])
    expect(phases.runners[0]?.verified).toBe(false)
  })
})

describe('reading a suite-granular snapshot', () => {
  test('decodes the snapshot a runner wrote', () => {
    const written = JSON.parse(JSON.stringify(protocolSnapshot('selective')))
    expect(readSnapshot(written, 'selective')).toEqual(
      protocolSnapshot('selective'),
    )
  })

  test('rejects another phase, a malformed plan, graph or outcome, and an unknown kind', () => {
    const base = JSON.parse(JSON.stringify(protocolSnapshot('selective')))
    expect(readSnapshot(base, 'full')).toBeNull()
    expect(
      readSnapshot(
        { ...base, plan: { ...base.plan, mode: 'record' } },
        'selective',
      ),
    ).toBeNull()
    expect(
      readSnapshot(
        { ...base, graph: { ...base.graph, protocolVersion: 2 } },
        'selective',
      ),
    ).toBeNull()
    expect(
      readSnapshot(
        { ...base, suiteOutcomes: { [SUITE_A]: 'skipped' } },
        'selective',
      ),
    ).toBeNull()
    expect(readSnapshot({ ...base, kind: 'future' }, 'selective')).toBeNull()
    const { suiteOutcomes: _, ...without } = base
    expect(readSnapshot(without, 'selective')).toBeNull()
  })

  test('a runtime snapshot that names its kind still decodes', () => {
    const written = JSON.parse(
      JSON.stringify({ ...exampleSnapshot('full'), kind: 'runtime' }),
    )
    expect(readSnapshot(written, 'full')).toMatchObject({ kind: 'runtime' })
  })
})
