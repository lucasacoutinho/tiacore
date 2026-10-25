import type { RoundResult } from '../../support/bench-report.ts'

/**
 * One thing `npm run bench` measures. `round` runs once per round and returns
 * one observation per metric; a workload that compares 2.0 with 1.x runs both
 * inside the round, in an order that alternates with the round index
 * (`interleave`), and returns the 2.0 / 1.x ratio as its own metric.
 */
export interface Workload {
  /** The name `--only` selects. */
  readonly name: string
  readonly round: (index: number) => Promise<RoundResult> | RoundResult
  readonly setup?: () => Promise<void> | void
  /** One line for `--list`: what is measured and how. */
  readonly summary: string
  readonly teardown?: () => Promise<void> | void
  /** Rounds run and discarded first, for the JIT and the file cache. */
  readonly warmup: number
}
