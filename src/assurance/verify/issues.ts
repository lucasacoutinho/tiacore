import * as Match from 'effect/Match'

import { canonicalJson } from '../../core/canonical.ts'
import type { TiaVerificationIssue } from '../../core/verification.ts'
import type { Verdict, VerdictIssue } from '../../core/verdict.ts'
import { hashBytes } from '../../engine/baseline/fingerprint.ts'

export function digest(value: unknown): string {
  return hashBytes(canonicalJson(value))
}

function describe(issue: VerdictIssue): string {
  return Match.value(issue).pipe(
    Match.discriminatorsExhaustive('code')({
      'coverage-mismatch': () =>
        'selective and full phases produced different reconstructed coverage evidence',
      'dependency-mismatch': () =>
        'selective and full phases produced different dependency evidence',
      'incomplete-graph': ({ phase }) =>
        `${phase} phase produced an incomplete graph`,
      'outcome-mismatch': () =>
        'selective and full phases produced different test outcomes',
      'selection-miss': ({ missed }) => {
        const remainder = missed.length - 3
        return `selective phase missed ${missed.length} required test${
          missed.length === 1 ? '' : 's'
        }: ${missed.slice(0, 3).join(', ')}${
          remainder > 0 ? ` and ${remainder} more` : ''
        }`
      },
    }),
  )
}

/** The verdict's failing guards as the receipt's issues for `runner`. */
export function verdictIssues(
  runner: string,
  result: Verdict,
): TiaVerificationIssue[] {
  return result.issues.map((issue) => ({
    code: issue.code,
    message: describe(issue),
    runner,
  }))
}
