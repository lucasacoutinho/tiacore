// Child process of the `effect` workload: runs a fiber-heavy Effect program in
// one of three ways and prints the median of a few runs, in milliseconds, as
// JSON. A process per mode keeps the tracker's wrapper on
// `AsyncResource.prototype.runInAsyncScope` out of the baseline: once
// installed it stays on the prototype.
//
//   node fibers-child.ts plain|tracked|leftover
//
// - plain: no leftover tracking, as in a worker without the plugin.
// - tracked: the plugin's tracking, fibers running inside the test that forked
//   them (the common case: every step passes the wrapper and is not charged).
// - leftover: the tracking, with fibers whose test already ended while another
//   test's window is open on a project of 300 instrumented files. Each step
//   costs two passes over every counter, up to MAX_LEFTOVER_STEPS per module.
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'

import { installProbe } from '../../../src/probe/index.ts'
import type { ProbeCoverageMap } from '../../../src/probe/types.ts'
import { trackLeftoverWork } from '../../../src/runners/vitest/leftover.ts'
import { exactMedian } from '../../support/stats.ts'

const FIBERS = 10_000
const STEPS = 5
const WARMUP = 1
const RUNS = 3

const program = Effect.forEach(
  Array.from({ length: FIBERS }, (_, n) => n),
  (n) =>
    Effect.forkChild(
      Effect.gen(function* () {
        for (let step = 0; step < STEPS; step += 1) yield* Effect.yieldNow
        return n
      }),
    ),
).pipe(Effect.flatMap((fibers) => Effect.forEach(fibers, Fiber.join)))

/** 300 files of 400 statements, 100 functions and 30 two-way branches. */
function coverage(): ProbeCoverageMap {
  const files: Record<string, ProbeCoverageMap[string]> = {}
  for (let file = 0; file < 300; file += 1) {
    const path = `/project/src/file${file}.ts`
    files[path] = {
      b: Object.fromEntries(
        Array.from({ length: 30 }, (_, branch) => [String(branch), [0, 0]]),
      ),
      f: Object.fromEntries(
        Array.from({ length: 100 }, (_, fn) => [String(fn), 0]),
      ),
      hash: `hash${file}`,
      path,
      s: Object.fromEntries(
        Array.from({ length: 400 }, (_, statement) => [String(statement), 0]),
      ),
    }
  }
  return files
}

const mode = process.argv[2]
if (mode !== 'plain' && mode !== 'tracked' && mode !== 'leftover') {
  throw new Error('usage: fibers-child.ts plain|tracked|leftover')
}

const live = mode === 'leftover' ? coverage() : {}
const probe = installProbe(() => live)
const tracking = mode === 'plain' ? undefined : trackLeftoverWork(probe)
if (mode !== 'plain' && tracking === undefined) {
  throw new Error('leftover tracking did not install')
}

/** One run of the program; only the program itself is timed. */
async function once(): Promise<number> {
  if (tracking === undefined) {
    const started = performance.now()
    await Effect.runPromise(program)
    return performance.now() - started
  }
  // The fibers belong to test `bench`. In `leftover` mode another test is the
  // one whose window is open, so the fibers' work is not its own.
  const open = mode === 'leftover' ? 'other' : 'bench'
  probe.closeModule()
  probe.beginTest(open)
  const started = performance.now()
  await tracking.run('bench', () => Effect.runPromise(program))
  const elapsed = performance.now() - started
  probe.endTest(open)
  return elapsed
}

const times: number[] = []
for (let index = 0; index < WARMUP + RUNS; index += 1) {
  const elapsed = await once()
  if (index >= WARMUP) times.push(elapsed)
}
process.stdout.write(
  `${JSON.stringify({ fibers: FIBERS, ms: exactMedian(times), steps: STEPS })}\n`,
)
