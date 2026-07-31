import type { CachedTestResult, RunPlan } from '../types.js'
import type {
  TiaReplayAdapter,
  TiaReplayCompleteEvent,
  TiaReplayedTestEvent,
  TiaReplayRunEvent,
} from './types.js'

export type ReplayAdapterEvent =
  | TiaReplayCompleteEvent
  | TiaReplayedTestEvent
  | TiaReplayRunEvent

export type ReplayAdapterMethod =
  | 'onRunComplete'
  | 'onRunStart'
  | 'onTestReplayed'

export function replayedResults(plan: RunPlan): CachedTestResult[] {
  if (plan.mode !== 'replay' || plan.graph === null) {
    return []
  }

  const affectedIds = new Set(plan.affectedTestIds)
  const wholeFiles = new Set(plan.wholeTestFiles)
  return Object.values(plan.graph.results)
    .filter(
      (result) =>
        result.state !== 'failed' &&
        !affectedIds.has(result.id) &&
        !wholeFiles.has(result.file),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
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

export async function notifyReplayAdapters(
  adapters: TiaReplayAdapter[],
  method: ReplayAdapterMethod,
  event: ReplayAdapterEvent,
  warn: (message: string) => void,
): Promise<void> {
  for (const adapter of adapters) {
    const handler = adapter[method] as
      | ((value: unknown) => Promise<void> | void)
      | undefined
    if (handler === undefined) {
      continue
    }

    try {
      await handler.call(adapter, event)
    } catch (error) {
      warn(
        `TIA replay adapter ${method} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
