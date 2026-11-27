import { relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import { globSync } from 'tinyglobby'

import type { CachedTestResult } from '../../core/runtime.ts'
import type { TiaObservation } from '../../engine/core.ts'
import type { CoreRun } from '../../engine/core-run.ts'
import { formatRunPlanDetails } from '../../engine/explain.ts'
import { slash } from '../../engine/host-path.ts'
import { skippedCommitMessage } from '../../engine/lifecycle.ts'
import { runPromise, type HostServices } from '../../host/runtime.ts'
import { fullyExecutedFiles } from './observations.ts'
import type { TiaRunnerResult } from './types.ts'

/** What observing a batch of test files produced. */
export interface FileObservations {
  /**
   * False when the batch cannot vouch for its evidence (an aggregate pass that
   * hit a module failure, a crash or the timeout). An incomplete run neither
   * succeeds nor commits a graph.
   */
  readonly complete: boolean
  /**
   * Test files the batch ran whole beyond those the plan asked for: it
   * observed every case they have now, so a cached case they did not report
   * no longer exists.
   */
  readonly fullyExecuted?: readonly string[]
  readonly observations: TiaObservation[]
}

export interface RunnerKernel {
  readonly core: CoreRun
  /** Absolute resolved test files. */
  readonly files: readonly string[]
  readonly label: 'bun' | 'node'
  readonly log: boolean
  readonly observeCachedCases: (
    results: readonly CachedTestResult[],
  ) => Effect.Effect<FileObservations, never, HostServices>
  readonly observeFiles: (
    files: readonly string[],
  ) => Effect.Effect<FileObservations, never, HostServices>
  readonly root: string
}

/** Resolves glob patterns against `root`, absolute, de-duplicated and sorted. */
export function resolveTestFiles(
  root: string,
  patterns: readonly string[],
): string[] {
  return [
    ...new Set(
      patterns.flatMap((pattern) =>
        globSync(pattern, {
          cwd: root,
          ignore: ['**/node_modules/**', '**/.tia/**'],
        }).map((file) => resolve(root, file)),
      ),
    ),
  ].sort()
}

export function relativeTestFiles(
  root: string,
  files: readonly string[],
): string[] {
  return files.map((file) => slash(relative(root, file)))
}

function print(kernel: RunnerKernel, message: string): void {
  if (kernel.log) console.log(message)
}

/**
 * The run flow Node and Bun share: plan, observe the files the plan needs
 * (every file when recording; whole-file fallbacks, then each affected cached
 * case when replaying), then commit what was observed.
 */
export async function runKernel(
  kernel: RunnerKernel,
): Promise<TiaRunnerResult> {
  const { core, label } = kernel
  const plan = await runPromise(core.prepare())
  print(
    kernel,
    plan.mode === 'record'
      ? `TIA ${label} recording full-suite baseline (${plan.reason}).`
      : `TIA ${label} replay: ${plan.reason}; ${plan.replayedTests} cached test result${
          plan.replayedTests === 1 ? '' : 's'
        }.`,
  )
  for (const line of formatRunPlanDetails(plan)) print(kernel, line)

  const wholeFiles =
    plan.mode === 'record'
      ? relativeTestFiles(kernel.root, kernel.files)
      : plan.wholeTestFiles

  const observe = Effect.gen(function* () {
    if (plan.mode === 'record') return yield* kernel.observeFiles(kernel.files)
    const whole = yield* kernel.observeFiles(
      plan.wholeTestFiles.map((file) => resolve(kernel.root, file)),
    )
    const cached = plan.affectedTestIds.flatMap((id) => {
      const result = plan.graph?.results[id]
      return result === undefined ? [] : [result]
    })
    const cases = yield* kernel.observeCachedCases(cached)
    return {
      complete: whole.complete && cases.complete,
      fullyExecuted: [
        ...(whole.fullyExecuted ?? []),
        ...(cases.fullyExecuted ?? []),
      ],
      observations: [...whole.observations, ...cases.observations],
    } satisfies FileObservations
  })
  const { complete, fullyExecuted, observations } = await runPromise(observe)

  let saved = false
  if (complete) {
    const outcome = await runPromise(
      core.commitOutcome(
        observations,
        fullyExecutedFiles(plan, observations, [
          ...wholeFiles,
          ...(fullyExecuted ?? []),
        ]),
      ),
    )
    if (outcome._tag === 'Committed') saved = true
    else if (kernel.log) console.warn(skippedCommitMessage(outcome))
  } else if (kernel.log) {
    console.error(
      `TIA ${label} could not vouch for this run (a module failed to load, a child crashed or timed out); the graph was not saved.`,
    )
  }
  print(
    kernel,
    `TIA ${label} complete: ${observations.length} executed, ${plan.replayedTests} replayed.`,
  )

  return {
    executedTests: observations,
    graphSaved: saved,
    plan,
    replayedTests: plan.replayedTests,
    success:
      complete &&
      observations.every((observation) => observation.state !== 'failed'),
  }
}
