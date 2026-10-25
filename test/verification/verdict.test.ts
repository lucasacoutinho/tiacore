import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'

import { verdict, type VerdictInput } from '../../src/core/verdict.ts'

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
