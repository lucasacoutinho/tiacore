import type { TiaReplayRunEvent } from './replay.ts'
import type { TiaPhaseSnapshot } from './verification.ts'

/** What the receipt reads from a snapshot's plan, whichever kind of runner wrote it. */
export interface SnapshotPlan {
  readonly changedFiles: readonly string[]
  readonly mode: TiaReplayRunEvent['mode']
  readonly reason: string
  readonly replayedTests: number
}

/**
 * A protocol plan seen as a replay plan: a `full` plan records everything, as
 * a runtime `record` plan does, and the suites it leaves cached are replayed.
 */
export function snapshotPlan(snapshot: TiaPhaseSnapshot): SnapshotPlan {
  if (snapshot.kind === 'protocol') {
    const { cached, changedFiles, mode, reason } = snapshot.plan
    return {
      changedFiles,
      mode: mode === 'full' ? 'record' : 'replay',
      reason,
      replayedTests: cached.length,
    }
  }
  const { changedFiles, mode, reason, replayedTests } = snapshot.plan
  return { changedFiles, mode, reason, replayedTests }
}
