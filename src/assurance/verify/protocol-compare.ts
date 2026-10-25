import { suiteOutcomesEqual, verdict } from '../../core/verdict.ts'
import type {
  TiaProtocolVerificationSnapshot,
  TiaVerificationIssue,
  TiaVerificationRunnerResult,
} from '../../core/verification.ts'
import { digest, verdictIssues } from './issues.ts'
import { auditProtocolSelection, planScope } from './protocol-selection.ts'

/** The dependency evidence: what each suite depends on, and the suites. */
function dependencies(snapshot: TiaProtocolVerificationSnapshot) {
  return {
    observations: snapshot.graph.observations,
    suites: snapshot.graph.suites.map((suite) => ({
      dependsOn: suite.dependsOn ?? [],
      file: suite.file,
      id: suite.id,
    })),
  }
}

function phaseOutcomes(snapshot: TiaProtocolVerificationSnapshot) {
  return {
    executed: snapshot.executedTestIds,
    outcomes: snapshot.suiteOutcomes,
    scope: planScope(snapshot.plan),
  }
}

function listed(ids: readonly string[]): string {
  const remainder = ids.length - 3
  return `${ids.slice(0, 3).join(', ')}${
    remainder > 0 ? ` and ${remainder} more` : ''
  }`
}

/**
 * Compares the two phases of a suite-granular runner: the same guards as a
 * test-granular runner, with suites in the part of tests. Outcomes are
 * compared over every suite either phase mentions (a suite the selective phase
 * did not run stands for the baseline's pass), dependency evidence is the
 * recorded observations, and the full phase has to have run its whole plan,
 * or its outcomes prove nothing about the suites the selective phase skipped.
 */
export function compareProtocolSnapshots(
  selective: TiaProtocolVerificationSnapshot,
  full: TiaProtocolVerificationSnapshot,
): TiaVerificationRunnerResult {
  const runner = full.runner
  const selection = auditProtocolSelection(selective, full)
  const fullRan = new Set(full.executedTestIds)
  const unrun = planScope(full.plan).filter((id) => !fullRan.has(id))
  const result = verdict({
    coverageChecked: false,
    coverageEqual: true,
    dependenciesEqual:
      digest(dependencies(selective)) === digest(dependencies(full)),
    executed: selection.executedTestIds,
    expected: selection.expectedTestIds,
    fullComplete: full.graph.complete && unrun.length === 0,
    outcomesEqual: suiteOutcomesEqual(
      phaseOutcomes(selective),
      phaseOutcomes(full),
    ),
    selectiveComplete: selective.graph.complete,
  })
  const issues = verdictIssues(runner, result).map(
    (issue): TiaVerificationIssue =>
      issue.code === 'incomplete-graph' &&
      issue.message.startsWith('full') &&
      full.graph.complete
        ? {
            ...issue,
            message: `full phase did not run ${unrun.length} suite${
              unrun.length === 1 ? '' : 's'
            } of its plan: ${listed(unrun)}`,
          }
        : issue,
  )
  return { issues, runner, selection, unit: 'suite', verified: result.verified }
}
