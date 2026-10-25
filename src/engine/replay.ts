import { sortByKey } from '../core/canonical.ts'
import type { TiaReplayAdapter, TiaReplayRunEvent } from '../core/replay.ts'
import type { CachedTestResult, RunPlan } from '../core/runtime.ts'

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
 * Calls one adapter method on every adapter in order, for example
 * `(adapter) => adapter.onRunStart?.(event)`. A failing adapter becomes a
 * warning and does not stop the others.
 */
export async function notifyReplayAdapters(
  adapters: readonly TiaReplayAdapter[],
  method: keyof TiaReplayAdapter,
  call: (adapter: TiaReplayAdapter) => Promise<void> | void,
  warn: (message: string) => void,
): Promise<void> {
  for (const adapter of adapters) {
    try {
      await call(adapter)
    } catch (error) {
      warn(
        `TIA replay adapter ${method} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
