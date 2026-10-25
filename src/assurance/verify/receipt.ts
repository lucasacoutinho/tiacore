import { byCodeUnit } from '../../core/canonical.ts'
import {
  type TiaVerificationAccuracy,
  type TiaVerificationIssue,
  type TiaVerificationPerformance,
  type TiaVerificationPhaseResult,
  type TiaVerificationRunnerResult,
  type TiaVerificationSnapshot,
} from '../../core/verification.ts'
import { compareVerificationSnapshots } from './compare.ts'

export interface ExecutedPhase {
  readonly duration: number
  readonly snapshots: readonly TiaVerificationSnapshot[]
  readonly status: number
}

function indexed(
  values: readonly TiaVerificationSnapshot[],
  issues: TiaVerificationIssue[],
): Map<string, TiaVerificationSnapshot> {
  const byRunner = new Map<string, TiaVerificationSnapshot>()
  for (const snapshot of values) {
    if (byRunner.has(snapshot.runner)) {
      issues.push({
        code: 'duplicate-snapshot',
        message: `phase produced more than one snapshot for ${snapshot.runner}`,
        runner: snapshot.runner,
      })
      continue
    }
    byRunner.set(snapshot.runner, snapshot)
  }
  return byRunner
}

export function comparePhases(
  selective: readonly TiaVerificationSnapshot[],
  full: readonly TiaVerificationSnapshot[],
): { issues: TiaVerificationIssue[]; runners: TiaVerificationRunnerResult[] } {
  const issues: TiaVerificationIssue[] = []
  const selectiveByRunner = indexed(selective, issues)
  const fullByRunner = indexed(full, issues)
  const names = [
    ...new Set([...selectiveByRunner.keys(), ...fullByRunner.keys()]),
  ].sort(byCodeUnit)
  const runners: TiaVerificationRunnerResult[] = []

  for (const runner of names) {
    const selectiveSnapshot = selectiveByRunner.get(runner)
    const fullSnapshot = fullByRunner.get(runner)
    if (selectiveSnapshot === undefined || fullSnapshot === undefined) {
      const phase = selectiveSnapshot === undefined ? 'selective' : 'full'
      const missing: TiaVerificationIssue = {
        code:
          phase === 'selective'
            ? 'missing-selective-snapshot'
            : 'missing-full-snapshot',
        message: `${phase} phase did not produce a snapshot for ${runner}`,
        runner,
      }
      issues.push(missing)
      runners.push({
        issues: [missing],
        runner,
        selection: null,
        verified: false,
      })
      continue
    }
    const result = compareVerificationSnapshots(selectiveSnapshot, fullSnapshot)
    issues.push(...result.issues)
    runners.push(result)
  }

  if (names.length === 0) {
    issues.push({
      code: 'snapshot-invalid',
      message: 'verification command did not produce any TIA snapshots',
    })
  }
  return { issues, runners }
}

export function accuracyReceipt(
  runners: readonly TiaVerificationRunnerResult[],
): TiaVerificationAccuracy {
  let executedTests = 0
  let expectedTests = 0
  let missedTests = 0
  let unnecessaryTests = 0
  for (const { selection } of runners) {
    if (selection === null) continue
    executedTests += selection.executedTestIds.length
    expectedTests += selection.expectedTestIds.length
    missedTests += selection.missedTestIds.length
    unnecessaryTests += selection.unnecessaryTestIds.length
  }
  return {
    executedTests,
    expectedTests,
    falseNegativeRate: expectedTests === 0 ? 0 : missedTests / expectedTests,
    missedTests,
    precision:
      executedTests === 0
        ? null
        : (executedTests - unnecessaryTests) / executedTests,
    unnecessaryTests,
  }
}

export function phaseResult(phase: ExecutedPhase): TiaVerificationPhaseResult {
  return {
    duration: phase.duration,
    metrics: phase.snapshots.map((snapshot) => ({
      executedTests: snapshot.executedTestIds.length,
      mode: snapshot.plan.mode,
      reason: snapshot.plan.reason,
      replayedTests: snapshot.plan.replayedTests,
      runner: snapshot.runner,
    })),
    runners: phase.snapshots
      .map((snapshot) => snapshot.runner)
      .sort(byCodeUnit),
    status: phase.status,
  }
}

function total(
  snapshots: readonly TiaVerificationSnapshot[],
  value: (snapshot: TiaVerificationSnapshot) => number,
): number {
  return snapshots.reduce((sum, snapshot) => sum + value(snapshot), 0)
}

export function performanceReceipt(
  selective: ExecutedPhase,
  full: ExecutedPhase,
): TiaVerificationPerformance {
  const selectiveExecutedTests = total(
    selective.snapshots,
    (snapshot) => snapshot.executedTestIds.length,
  )
  const fullExecutedTests = total(
    full.snapshots,
    (snapshot) => snapshot.executedTestIds.length,
  )
  return {
    durationSaved: full.duration - selective.duration,
    executionReduction:
      fullExecutedTests === 0
        ? null
        : 1 - selectiveExecutedTests / fullExecutedTests,
    fallbacks: selective.snapshots.flatMap((snapshot) =>
      snapshot.plan.mode === 'record'
        ? [{ reason: snapshot.plan.reason, runner: snapshot.runner }]
        : [],
    ),
    fullExecutedTests,
    selectiveExecutedTests,
    selectiveReplayedTests: total(
      selective.snapshots,
      (snapshot) => snapshot.plan.replayedTests,
    ),
    speedup:
      selective.duration === 0 ? null : full.duration / selective.duration,
  }
}
