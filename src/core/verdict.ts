// Implements proofs/Tia/Verdict.lean `Compare.issues` / `Compare.verified`. The
// verdict of `tiacore verify` for one runner: every failing guard is reported,
// in the model's order, and the runner is verified exactly when none fails.

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
