import { fileURLToPath } from 'node:url'

import { ms, ratio } from '../../support/bench-report.ts'
import { interleave, spawnTimed } from '../../support/bench-run.ts'
import { PLAIN_PROJECT } from '../../support/bench-vitest.ts'
import { vitestWorkload } from './vitest.ts'

const child = fileURLToPath(new URL('./fibers-child.ts', import.meta.url))

type Mode = 'leftover' | 'plain' | 'tracked'

function fibers(mode: Mode): number {
  const output = spawnTimed(process.execPath, [child, mode]).stdout.trim()
  const parsed: unknown = JSON.parse(output)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('ms' in parsed) ||
    typeof parsed.ms !== 'number'
  ) {
    throw new Error(`fibers-child printed ${output}`)
  }
  return parsed.ms
}

/**
 * The cost of the leftover tracking that the Vitest plugin installs in every
 * worker (src/runners/vitest/leftover.ts wraps
 * `AsyncResource.prototype.runInAsyncScope`, which Effect runs every fiber
 * step through), in a process that does nothing but run 10,000 forked fibers
 * that yield: without the tracking, with it in the common case, and with it
 * when the fibers outlive their test (see fibers-child.ts).
 */
function trackingCost(index: number) {
  const measured = new Map<Mode, number>()
  for (const mode of interleave(
    ['plain', 'tracked', 'leftover'] as const,
    index,
  )) {
    measured.set(mode, fibers(mode))
  }
  const plain = measured.get('plain') ?? Number.NaN
  const tracked = measured.get('tracked') ?? Number.NaN
  const leftover = measured.get('leftover') ?? Number.NaN
  return {
    'fibers-leftover': ms(leftover),
    'fibers-leftover-vs-plain': ratio(leftover / plain),
    'fibers-plain': ms(plain),
    'fibers-tracked': ms(tracked),
    'fibers-tracked-vs-plain': ratio(tracked / plain),
  }
}

/**
 * The Vitest workload over `it.effect` tests that fork and join sixteen child
 * fibers and leave one detached, plus the tracking cost in isolation.
 */
export const effect = vitestWorkload({
  extra: trackingCost,
  name: 'effect',
  shape: { ...PLAIN_PROJECT, kind: 'effect' },
  summary:
    'the vitest workload with @effect/vitest tests that fork fibers (same shape as vitest), and the leftover tracking cost on 10,000 fibers in one process',
})
