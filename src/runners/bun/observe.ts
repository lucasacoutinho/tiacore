import { join, relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import type { CachedTestResult } from '../../core/runtime.ts'
import type { TiaObservation } from '../../engine/core.ts'
import { slash } from '../../engine/host-path.ts'
import type { HostServices } from '../../host/runtime.ts'
import { groupBy } from '../shared/concurrency.ts'
import {
  moduleFailureObservation,
  observationOf,
} from '../shared/observations.ts'
import { childEnvironment, runChild } from '../shared/process.ts'
import type { FileObservations } from '../shared/run.ts'
import { parseBunJunit, parseBunLcov, type BunCase } from './report.ts'

/** A bun child that outlives this is killed and its file counts as failed. */
const EXECUTION_TIMEOUT_MS = 30_000

export interface BunContext {
  readonly binary: string
  readonly concurrency: number
  readonly root: string
  /** Child time limit; defaults to 30 seconds. */
  readonly timeoutMs?: number
}

interface BunExecution {
  cases: BunCase[]
  coverageFiles: string[]
  output: string
  success: boolean
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Runs `bun test` over `files` filtered by `pattern`. Anything that leaves no
 * usable report (spawn error, missing results.xml, missing lcov.info when
 * coverage is requested) is a failed execution with no cases.
 */
const executeBun = (
  context: BunContext,
  files: readonly string[],
  pattern: string,
  coverage: boolean,
): Effect.Effect<BunExecution, never, HostServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: 'tiacore-bun-run-',
      })
      const junitPath = join(temporary, 'results.xml')
      const outcome = yield* runChild({
        args: [
          'test',
          `--test-name-pattern=${pattern}`,
          '--reporter=junit',
          `--reporter-outfile=${junitPath}`,
          ...(coverage
            ? [
                '--coverage',
                '--coverage-reporter=lcov',
                `--coverage-dir=${temporary}`,
              ]
            : []),
          ...files,
        ],
        command: context.binary,
        cwd: context.root,
        env: childEnvironment({ NO_COLOR: '1' }),
        stdio: 'capture',
        timeoutMs: context.timeoutMs ?? EXECUTION_TIMEOUT_MS,
      })
      const cases = parseBunJunit(
        context.root,
        yield* fs.readFileString(junitPath),
      )
      const coverageFiles = coverage
        ? parseBunLcov(
            context.root,
            yield* fs.readFileString(join(temporary, 'lcov.info')),
          )
        : []
      return {
        cases,
        coverageFiles,
        output: outcome.output,
        success: outcome.code === 0,
      } satisfies BunExecution
    }),
  ).pipe(
    Effect.orElseSucceed((): BunExecution => ({
      cases: [],
      coverageFiles: [],
      output: 'bun produced no usable report',
      success: false,
    })),
  )

const observeCandidate = Effect.fnUntraced(function* (
  context: BunContext,
  candidate: BunCase,
) {
  const execution = yield* executeBun(
    context,
    [resolve(context.root, candidate.file)],
    `^${escapeRegExp(candidate.fullName)}$`,
    true,
  )
  const result = execution.cases.find(
    (item) => item.id === candidate.id || item.fullName === candidate.fullName,
  )
  // A failed process without a failed test result is a module failure: the
  // file did not load, or the selected case never ran (describe, skip, todo).
  if (
    !execution.success &&
    (result === undefined || result.state !== 'failed')
  ) {
    return moduleFailureObservation(candidate.file)
  }
  return observationOf(result ?? { ...candidate, state: 'failed' }, [
    candidate.file,
    ...execution.coverageFiles,
  ])
})

/**
 * Observes test files: one discovery process per file (a pattern that matches
 * nothing makes Bun list the file's tests without running them), then one
 * process per discovered case. Files run in parallel, the cases of one file in
 * order.
 */
export const observeBunFiles = Effect.fnUntraced(function* (
  context: BunContext,
  files: readonly string[],
) {
  if (files.length === 0) {
    return { complete: true, observations: [] } satisfies FileObservations
  }
  const discoveries = yield* Effect.forEach(
    files,
    (file) =>
      executeBun(context, [file], 'a^', false).pipe(
        Effect.map((execution) => ({
          execution,
          file: slash(relative(context.root, file)),
        })),
      ),
    { concurrency: context.concurrency },
  )
  const discovered: BunCase[] = []
  const observations: TiaObservation[] = []
  for (const { execution, file } of discoveries) {
    if (
      !execution.success &&
      !(
        execution.cases.length > 0 &&
        execution.output.includes('matched 0 tests')
      )
    ) {
      observations.push(moduleFailureObservation(file))
    } else {
      discovered.push(...execution.cases)
    }
  }

  const groups = groupBy(discovered, (candidate) => candidate.file)
  const perFile = yield* Effect.forEach(
    [...groups.values()],
    (candidates) =>
      Effect.gen(function* () {
        const fileObservations: TiaObservation[] = []
        for (const candidate of candidates) {
          fileObservations.push(yield* observeCandidate(context, candidate))
        }
        return fileObservations
      }),
    { concurrency: context.concurrency },
  )
  observations.push(...perFile.flat())
  return { complete: true, observations } satisfies FileObservations
})

const observeCachedCase = Effect.fnUntraced(function* (
  context: BunContext,
  cached: CachedTestResult,
) {
  const execution = yield* executeBun(
    context,
    [resolve(context.root, cached.file)],
    `^${escapeRegExp(cached.fullName)}$`,
    true,
  )
  const result = execution.cases.find(
    (item) => item.id === cached.id || item.fullName === cached.fullName,
  )
  if (
    result !== undefined &&
    (execution.success || result.state === 'failed')
  ) {
    return [observationOf(result, [cached.file, ...execution.coverageFiles])]
  }
  return execution.success ? [] : [moduleFailureObservation(cached.file)]
})

/** Re-runs affected cached cases, grouped by file: files in parallel, cases in order. */
export const observeBunCachedCases = Effect.fnUntraced(function* (
  context: BunContext,
  cached: readonly CachedTestResult[],
) {
  const groups = groupBy(cached, (result) => result.file)
  const perFile = yield* Effect.forEach(
    [...groups.values()],
    (results) =>
      Effect.gen(function* () {
        const observations: TiaObservation[] = []
        for (const result of results) {
          observations.push(...(yield* observeCachedCase(context, result)))
        }
        return observations
      }),
    { concurrency: context.concurrency },
  )
  return perFile.flat()
})
