import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'

import {
  suiteOutcomesEqual,
  verdict,
  type SuitePhaseOutcomes,
  type VerdictInput,
} from '../../src/core/verdict.ts'

// A transcription of proofs/Tia/Verdict.lean: `Compare.guards`, `allFails`
// (via `Compare.issues`) and `Compare.verified`, over lists of keys.
type Issue =
  | 'selectionMiss'
  | 'incompleteGraph'
  | 'outcomeMismatch'
  | 'dependencyMismatch'
  | 'coverageMismatch'

const missed = (c: VerdictInput) =>
  c.expected.filter((key) => !c.executed.includes(key))

const guards = (c: VerdictInput): [boolean, Issue][] => [
  [missed(c).length === 0, 'selectionMiss'],
  [c.selectiveComplete, 'incompleteGraph'],
  [c.fullComplete, 'incompleteGraph'],
  [c.outcomesEqual, 'outcomeMismatch'],
  [c.dependenciesEqual, 'dependencyMismatch'],
  [!c.coverageChecked || c.coverageEqual, 'coverageMismatch'],
]

const allFails = (c: VerdictInput): Issue[] =>
  guards(c).flatMap(([ok, issue]) => (ok ? [] : [issue]))

const modelIssue = {
  'coverage-mismatch': 'coverageMismatch',
  'dependency-mismatch': 'dependencyMismatch',
  'incomplete-graph': 'incompleteGraph',
  'outcome-mismatch': 'outcomeMismatch',
  'selection-miss': 'selectionMiss',
} as const

const keys = Schema.Array(Schema.Literals(['a', 'b', 'c', 'd']))
const compare = Arbitrary.schema(
  Schema.Struct({
    coverageChecked: Schema.Boolean,
    coverageEqual: Schema.Boolean,
    dependenciesEqual: Schema.Boolean,
    executed: keys,
    expected: keys,
    fullComplete: Schema.Boolean,
    outcomesEqual: Schema.Boolean,
    selectiveComplete: Schema.Boolean,
  }),
)

describe('verification verdict', () => {
  it.prop(
    'reports exactly the failing guards of Verdict.lean, in order',
    [compare],
    ([input]) => {
      const result = verdict(input)
      expect(result.issues.map((issue) => modelIssue[issue.code])).toEqual(
        allFails(input),
      )
      expect(result.missed).toEqual(missed(input))
    },
  )

  it.prop(
    'verified_iff: verified exactly when every comparison holds',
    [compare],
    ([input]) => {
      const everyExpectedRan = input.expected.every((key) =>
        input.executed.includes(key),
      )
      expect(verdict(input).verified).toBe(
        everyExpectedRan &&
          input.selectiveComplete &&
          input.fullComplete &&
          input.outcomesEqual &&
          input.dependenciesEqual &&
          (!input.coverageChecked || input.coverageEqual),
      )
    },
  )

  it.prop(
    'miss_fails: a missed required test never verifies',
    [compare],
    ([input]) => {
      if (missed(input).length > 0) expect(verdict(input).verified).toBe(false)
    },
  )

  it('cleanCompare verifies (anti-vacuity)', () => {
    expect(
      verdict({
        coverageChecked: false,
        coverageEqual: false,
        dependenciesEqual: true,
        executed: ['a', 'b'],
        expected: ['a'],
        fullComplete: true,
        outcomesEqual: true,
        selectiveComplete: true,
      }).verified,
    ).toBe(true)
  })
})

// A transcription of the suite-outcome half of proofs/Tia/Verdict.lean:
// `SuitePhase.effective`, `Agree` and `outcomesEq`.
type Result = 'failed' | 'passed' | 'unknown'

const effective = (phase: SuitePhaseOutcomes, key: string): Result | null =>
  phase.executed.includes(key)
    ? (phase.outcomes[key] ?? 'unknown')
    : phase.scope.includes(key)
      ? 'passed'
      : null

const mentioned = (s: SuitePhaseOutcomes, f: SuitePhaseOutcomes) => [
  ...s.scope,
  ...s.executed,
  ...f.scope,
  ...f.executed,
]

const agree = (s: SuitePhaseOutcomes, f: SuitePhaseOutcomes, key: string) => {
  const a = effective(s, key)
  const b = effective(f, key)
  return a !== null && b !== null && a === b && a !== 'unknown'
}

const outcomesEq = (s: SuitePhaseOutcomes, f: SuitePhaseOutcomes) =>
  mentioned(s, f).every((key) => agree(s, f, key))

const phase = Arbitrary.schema(
  Schema.Struct({
    executed: keys,
    outcomes: Schema.Array(
      Schema.Tuple([
        Schema.Literals(['a', 'b', 'c', 'd']),
        Schema.Literals(['failed', 'passed', 'unknown']),
      ]),
    ),
    scope: keys,
  }),
)

const toPhase = (value: {
  readonly executed: readonly string[]
  readonly outcomes: readonly (readonly [string, Result])[]
  readonly scope: readonly string[]
}): SuitePhaseOutcomes => ({
  executed: value.executed,
  outcomes: Object.fromEntries(value.outcomes),
  scope: value.scope,
})

describe('suite outcome verdict', () => {
  it.prop(
    'outcomesEq: agrees exactly when every mentioned suite has the same known outcome',
    [phase, phase],
    ([left, right]) => {
      const s = toPhase(left)
      const f = toPhase(right)
      expect(suiteOutcomesEqual(s, f)).toBe(outcomesEq(s, f))
    },
  )

  it.prop(
    'unselected_failure_detected: a suite the selective phase skipped cannot hide a full-phase failure',
    [phase, phase],
    ([left, right]) => {
      const s = toPhase(left)
      const f = toPhase(right)
      for (const key of mentioned(s, f)) {
        if (!s.executed.includes(key) && effective(f, key) === 'failed') {
          expect(suiteOutcomesEqual(s, f)).toBe(false)
        }
      }
    },
  )

  it.prop(
    'unknown_never_agrees: an unattributed outcome never verifies',
    [phase, phase],
    ([left, right]) => {
      const s = toPhase(left)
      const f = toPhase(right)
      if (mentioned(s, f).some((key) => effective(s, key) === 'unknown')) {
        expect(suiteOutcomesEqual(s, f)).toBe(false)
      }
    },
  )

  it('agrees when the selective phase ran one suite and the full phase both (anti-vacuity)', () => {
    const scope = ['a', 'b']
    const selective = {
      executed: ['a'],
      outcomes: { a: 'passed' as const },
      scope,
    }
    expect(
      suiteOutcomesEqual(selective, {
        executed: ['a', 'b'],
        outcomes: { a: 'passed', b: 'passed' },
        scope,
      }),
    ).toBe(true)
    expect(
      suiteOutcomesEqual(selective, {
        executed: ['a', 'b'],
        outcomes: { a: 'passed', b: 'failed' },
        scope,
      }),
    ).toBe(false)
  })
})
