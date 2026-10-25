import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import type { TiaObservation } from '../engine/core.ts'
import { CoreRun } from '../engine/core-run.ts'
import { recordSpans, runPromise } from '../host/runtime.ts'
import type { FinishedSpan } from '../host/observe.ts'
import { errorMessage, TiaIo } from '../wire/errors.ts'
import { runGit } from './doctor-checks.ts'

/** Test files in the throwaway project; enough to make the stages measurable. */
export const PERF_TEST_FILES = 40

export interface PerfPhase {
  readonly milliseconds: number
  readonly name: string
}

export interface PerfSpan {
  readonly count: number
  readonly maxMilliseconds: number
  readonly name: string
  readonly totalMilliseconds: number
}

export interface PerfReport {
  /** The phases, slowest first. */
  readonly phases: readonly PerfPhase[]
  readonly project: { readonly testFiles: number }
  /** Where the time went inside the phases, largest total first. */
  readonly spans: readonly PerfSpan[]
}

/** Groups finished spans by name, largest total time first. */
export function summarizeSpans(
  spans: readonly FinishedSpan[],
): readonly PerfSpan[] {
  const byName = new Map<
    string,
    { count: number; max: number; total: number }
  >()
  for (const span of spans) {
    const entry = byName.get(span.name) ?? { count: 0, max: 0, total: 0 }
    entry.count += 1
    entry.total += span.durationMs
    entry.max = Math.max(entry.max, span.durationMs)
    byName.set(span.name, entry)
  }
  return [...byName]
    .map(([name, entry]) => ({
      count: entry.count,
      maxMilliseconds: entry.max,
      name,
      totalMilliseconds: entry.total,
    }))
    .sort(
      (left, right) =>
        right.totalMilliseconds - left.totalMilliseconds ||
        (left.name < right.name ? -1 : 1),
    )
}

/** The identity a commit in the throwaway project needs, whatever the user's config. */
const IDENTITY = [
  '-c',
  'user.name=tiacore',
  '-c',
  'user.email=doctor@tiacore.invalid',
  '-c',
  'commit.gpgsign=false',
]

const git = Effect.fnUntraced(function* (cwd: string, args: readonly string[]) {
  const outcome = yield* runGit([...IDENTITY, ...args], cwd)
  if (outcome.code !== 0) {
    return yield* new TiaIo({
      message: `git ${args.join(' ')} exited with ${outcome.status}`,
    })
  }
})

const writeProject = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(join(root, 'src'), { recursive: true })
  yield* fs.makeDirectory(join(root, 'test'), { recursive: true })
  yield* fs.writeFileString(join(root, '.gitignore'), '.tia/\n')
  yield* fs.writeFileString(join(root, 'package.json'), '{"type":"module"}\n')
  for (let index = 0; index < PERF_TEST_FILES; index += 1) {
    yield* fs.writeFileString(
      join(root, 'src', `m${index}.mjs`),
      `export const value = ${index}\n`,
    )
    yield* fs.writeFileString(
      join(root, 'test', `m${index}.test.mjs`),
      `import { value } from '../src/m${index}.mjs'\nvalue\n`,
    )
  }
})

function observations(): TiaObservation[] {
  return Array.from({ length: PERF_TEST_FILES }, (_, index) => ({
    file: `test/m${index}.test.mjs`,
    files: [`src/m${index}.mjs`],
    fullName: `m${index}`,
    id: `test/m${index}.test.mjs::m${index}`,
    state: 'passed' as const,
  }))
}

async function timed(
  phases: PerfPhase[],
  name: string,
  body: () => Promise<unknown>,
): Promise<void> {
  const start = performance.now()
  await body()
  phases.push({ milliseconds: performance.now() - start, name })
}

/**
 * Times a cold prepare, a commit and a warm prepare on a throwaway git
 * project under the temp directory, and reports where the time went. The
 * user's project is never read or written.
 */
export const measurePerformance = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: 'tiacore-doctor-' })
    .pipe(
      Effect.mapError(
        (error) => new TiaIo({ cause: error, message: error.message }),
      ),
    )
  const setup = performance.now()
  yield* writeProject(root).pipe(
    Effect.mapError(
      (error) => new TiaIo({ cause: error, message: error.message }),
    ),
  )
  yield* git(root, ['init', '-q'])
  yield* git(root, ['add', '.'])
  yield* git(root, ['commit', '-q', '-m', 'baseline'])
  const setupMilliseconds = performance.now() - setup

  const testFiles = Array.from(
    { length: PERF_TEST_FILES },
    (_, index) => `test/m${index}.test.mjs`,
  )
  const options = {
    files: testFiles,
    fresh: false,
    log: false,
    root,
    runner: 'doctor',
    testFiles,
  }
  const phases: PerfPhase[] = []
  const { spans } = yield* Effect.tryPromise({
    catch: (error) =>
      new TiaIo({
        cause: error,
        message: errorMessage(error),
      }),
    try: () =>
      recordSpans(async () => {
        // An empty environment keeps a verification run's variables out of
        // the throwaway project.
        const cold = new CoreRun(options, {})
        await timed(phases, 'prepare (cold, no stored graph)', () =>
          runPromise(cold.prepare()),
        )
        await timed(phases, `commit (${PERF_TEST_FILES} tests)`, () =>
          runPromise(cold.commit(observations(), testFiles)),
        )
        await writeFile(
          join(root, 'src', 'm0.mjs'),
          'export const value = -1\n',
        )
        const warm = new CoreRun(options, {})
        await timed(phases, 'prepare (warm, one source file changed)', () =>
          runPromise(warm.prepare()),
        )
      }),
  })
  phases.unshift({
    milliseconds: setupMilliseconds,
    name: 'project setup (git init and commit)',
  })
  return {
    phases: phases.sort(
      (left, right) => right.milliseconds - left.milliseconds,
    ),
    project: { testFiles: PERF_TEST_FILES },
    spans: summarizeSpans(spans),
  } satisfies PerfReport
})
