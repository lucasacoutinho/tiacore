import { sortByKey } from '../core/canonical.ts'
import type { TiaReplayAdapter, TiaReplayRunEvent } from '../core/replay.ts'
import type { CachedTestResult, RunPlan } from '../core/runtime.ts'
import { errorMessage } from '../wire/errors.ts'

/** Cached results the plan replays instead of running, in id order. */
export function replayedResults(plan: RunPlan): CachedTestResult[] {
  if (plan.mode !== 'replay' || plan.graph === null) return []
  const affectedIds = new Set(plan.affectedTestIds)
  const wholeFiles = new Set(plan.wholeTestFiles)
  return sortByKey(
    Object.values(plan.graph.results).filter(
      (result) =>
        result.state !== 'failed' &&
        !affectedIds.has(result.id) &&
        !wholeFiles.has(result.file),
    ),
    (result) => result.id,
  )
}

export function replayRunEvent(plan: RunPlan): TiaReplayRunEvent {
  return {
    affectedTestIds: [...plan.affectedTestIds],
    affectedTests: [...plan.affectedTests],
    baseline: structuredClone(plan.baseline),
    changedFiles: [...plan.changedFiles],
    decisions: structuredClone(plan.decisions),
    mode: plan.mode,
    reason: plan.reason,
    replayedTests: plan.replayedTests,
    wholeTestFiles: [...plan.wholeTestFiles],
  }
}

/**
 * Calls one adapter method on every adapter in order. A failing adapter
 * becomes a warning and does not stop the others.
 */
async function notifyAdapters(
  adapters: readonly TiaReplayAdapter[],
  method: keyof TiaReplayAdapter,
  call: (adapter: TiaReplayAdapter) => Promise<void> | void,
  warn: (message: string) => void,
): Promise<void> {
  for (const adapter of adapters) {
    try {
      await call(adapter)
    } catch (error) {
      warn(`TIA replay adapter ${method} failed: ${errorMessage(error)}`)
    }
  }
}

/**
 * Tells the adapters a run is starting (`onRunStart`), then about each cached
 * result the plan replays (`onTestReplayed`). `afterReplayed` runs once the
 * adapters have heard about a result, for hosts that also announce it elsewhere.
 */
export async function notifyRunStart(
  adapters: readonly TiaReplayAdapter[],
  plan: RunPlan,
  warn: (message: string) => void,
  afterReplayed?: (result: CachedTestResult) => Promise<void>,
): Promise<void> {
  const start = replayRunEvent(plan)
  await notifyAdapters(
    adapters,
    'onRunStart',
    (adapter) => adapter.onRunStart?.(start),
    warn,
  )
  for (const result of replayedResults(plan)) {
    const event = { result: structuredClone(result) }
    await notifyAdapters(
      adapters,
      'onTestReplayed',
      (adapter) => adapter.onTestReplayed?.(event),
      warn,
    )
    await afterReplayed?.(result)
  }
}

/** Tells the adapters a committed run is complete. */
export async function notifyRunComplete(
  adapters: readonly TiaReplayAdapter[],
  plan: RunPlan,
  run: {
    readonly coverageReportDirectory: string | null
    readonly executedTestFiles: Iterable<string>
  },
  warn: (message: string) => void,
): Promise<void> {
  const complete = {
    ...replayRunEvent(plan),
    coverageReportDirectory: run.coverageReportDirectory,
    executedTestFiles: [...run.executedTestFiles].sort(),
  }
  await notifyAdapters(
    adapters,
    'onRunComplete',
    (adapter) => adapter.onRunComplete?.(complete),
    warn,
  )
}
