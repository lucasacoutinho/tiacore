// Implements proofs/Tia/Verdict.lean `Compare.issues` / `Compare.verified`. The
// verdict of `tiacore verify` for one runner: every failing guard is reported,
// in the model's order, and the runner is verified exactly when none fails.
// `suiteOutcomesEqual` implements the model's `outcomesEq`, the outcome guard
// of the suite-granular runners.

import type { TiaSuiteOutcome } from './verification.ts'

export interface VerdictInput {
  /** Tests the change obliges, derived from the union of both graphs. */
  readonly expected: readonly string[]
  /** Tests the selective phase ran. */
  readonly executed: readonly string[]
  readonly selectiveComplete: boolean
  readonly fullComplete: boolean
  readonly outcomesEqual: boolean
  readonly dependenciesEqual: boolean
  readonly coverageChecked: boolean
  readonly coverageEqual: boolean
}

export type VerdictIssue =
  | { readonly code: 'selection-miss'; readonly missed: readonly string[] }
  | {
      readonly code: 'incomplete-graph'
      readonly phase: 'full' | 'selective'
    }
  | { readonly code: 'outcome-mismatch' }
  | { readonly code: 'dependency-mismatch' }
  | { readonly code: 'coverage-mismatch' }

export interface Verdict {
  readonly issues: readonly VerdictIssue[]
  /** Expected tests the selective phase did not run, in `expected` order. */
  readonly missed: readonly string[]
  readonly verified: boolean
}

export function verdict(input: VerdictInput): Verdict {
  const executed = new Set(input.executed)
  const missed = input.expected.filter((id) => !executed.has(id))
  const issues: VerdictIssue[] = []
  if (missed.length > 0) issues.push({ code: 'selection-miss', missed })
  if (!input.selectiveComplete) {
    issues.push({ code: 'incomplete-graph', phase: 'selective' })
  }
  if (!input.fullComplete) {
    issues.push({ code: 'incomplete-graph', phase: 'full' })
  }
  if (!input.outcomesEqual) issues.push({ code: 'outcome-mismatch' })
  if (!input.dependenciesEqual) issues.push({ code: 'dependency-mismatch' })
  if (input.coverageChecked && !input.coverageEqual) {
    issues.push({ code: 'coverage-mismatch' })
  }
  return { issues, missed, verified: issues.length === 0 }
}

/** One phase of a suite-granular run, as far as outcomes go (`SuitePhase`). */
export interface SuitePhaseOutcomes {
  /** The suites the phase's plan covered, run or not. */
  readonly scope: readonly string[]
  /** The suites the phase ran. */
  readonly executed: readonly string[]
  /** How each executed suite ended; a missing entry is `unknown`. */
  readonly outcomes: Readonly<Record<string, TiaSuiteOutcome>>
}

/**
 * What a phase says about a suite (`SuitePhase.effective`): an executed suite's
 * own outcome, the carried-over pass of a covered suite it did not run, and
 * `null` for a suite outside its plan.
 */
function effectiveOutcome(
  phase: {
    readonly executed: ReadonlySet<string>
    readonly outcomes: ReadonlyMap<string, TiaSuiteOutcome>
    readonly scope: ReadonlySet<string>
  },
  id: string,
): TiaSuiteOutcome | null {
  if (phase.executed.has(id)) return phase.outcomes.get(id) ?? 'unknown'
  return phase.scope.has(id) ? 'passed' : null
}

function indexed(phase: SuitePhaseOutcomes) {
  return {
    executed: new Set(phase.executed),
    outcomes: new Map(Object.entries(phase.outcomes)),
    scope: new Set(phase.scope),
  }
}

/**
 * `outcomesEq`: the phases agree when every suite either one mentions has the
 * same known outcome in both. A graph is only promoted after every suite
 * passed, so a suite the selective phase did not run stands for the baseline
 * and counts as passed; a failure the full phase finds in it is a difference.
 * An outcome the run could not attribute (`unknown`) never agrees.
 */
export function suiteOutcomesEqual(
  selective: SuitePhaseOutcomes,
  full: SuitePhaseOutcomes,
): boolean {
  const left = indexed(selective)
  const right = indexed(full)
  const mentioned = new Set([
    ...selective.scope,
    ...selective.executed,
    ...full.scope,
    ...full.executed,
  ])
  for (const id of mentioned) {
    const a = effectiveOutcome(left, id)
    if (a === null || a === 'unknown' || a !== effectiveOutcome(right, id)) {
      return false
    }
  }
  return true
}
