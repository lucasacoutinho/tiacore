import { byCodeUnit } from '../../core/canonical.ts'
import type { TiaVerificationSelection } from '../../core/verification.ts'

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

/**
 * The selection receipt for the units a change obliged (`expected`) against
 * those the selective phase ran (`executed`), tests or suites alike.
 */
export function selectionReport(
  changedFiles: readonly string[],
  expected: ReadonlySet<string>,
  executed: ReadonlySet<string>,
): TiaVerificationSelection {
  const expectedTestIds = [...expected].sort(byCodeUnit)
  const executedTestIds = [...executed].sort(byCodeUnit)
  const missedTestIds = expectedTestIds.filter((id) => !executed.has(id))
  const unnecessaryTestIds = executedTestIds.filter((id) => !expected.has(id))
  return {
    changedFiles: [...changedFiles].sort(byCodeUnit),
    executedTestIds,
    expectedTestIds,
    falseNegativeRate: rate(missedTestIds.length, expectedTestIds.length),
    missedTestIds,
    precision:
      executedTestIds.length === 0
        ? null
        : (executedTestIds.length - unnecessaryTestIds.length) /
          executedTestIds.length,
    unnecessaryTestIds,
  }
}
