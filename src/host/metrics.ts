import { getHeapStatistics } from 'node:v8'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Metric from 'effect/Metric'

/**
 * The metrics tiacore reports. They are per host run (one prepare, one
 * commit, one verification), never per test, and carry only the outcome as an
 * attribute, so the number of series stays fixed.
 */

const runs = Metric.counter('tia_runs_total', {
  description: 'Host runs by outcome',
  incremental: true,
})

const runDuration = Metric.histogram('tia_run_duration_ms', {
  boundaries: Metric.exponentialBoundaries({ count: 16, factor: 2, start: 1 }),
  description: 'Wall time of one host run in milliseconds',
})

const heapUsed = Metric.gauge('tia_heap_used_bytes', {
  description: 'V8 heap in use when the last host run ended',
})

export type RunOutcome = 'defect' | 'failure' | 'interrupted' | 'success'

export function outcomeOf(exit: Exit.Exit<unknown, unknown>): RunOutcome {
  if (Exit.isSuccess(exit)) return 'success'
  if (Exit.hasInterrupts(exit)) return 'interrupted'
  return Exit.hasDies(exit) ? 'defect' : 'failure'
}

/** Records one finished host run. */
export const recordRun = (
  exit: Exit.Exit<unknown, unknown>,
  durationMs: number,
) =>
  Effect.all(
    [
      Metric.update(
        Metric.withAttributes(runs, { outcome: outcomeOf(exit) }),
        1,
      ),
      Metric.update(runDuration, durationMs),
      Metric.update(heapUsed, getHeapStatistics().used_heap_size),
    ],
    { discard: true },
  )
