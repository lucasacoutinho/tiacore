import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { TiaCore, type TiaObservation } from '../engine/core.ts'
import { recordSpans } from '../host/runtime.ts'
import type { FinishedSpan } from '../host/observe.ts'
import { TiaIo } from '../wire/errors.ts'

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

const git = Effect.fnUntraced(function* (cwd: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* Effect.scoped(
    Effect.flatMap(
      spawner.spawn(
        ChildProcess.make(
          'git',
          [
            '-c',
            'user.name=tiacore',
            '-c',
            'user.email=doctor@tiacore.invalid',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { cwd, stderr: 'ignore', stdin: 'ignore', stdout: 'ignore' },
        ),
      ),
      (handle) => handle.exitCode,
    ),
  ).pipe(
    Effect.mapError(
      (error) => new TiaIo({ cause: error, message: error.message }),
    ),
  )
  if (Number(code) !== 0) {
    return yield* new TiaIo({
      message: `git ${args.join(' ')} exited with ${code}`,
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

/** The environment variables that would make a commit write outside the throwaway project. */
const ESCAPING_VARIABLES = [
  'TIA_FRESH',
  'TIA_VERIFICATION_DIRECTORY',
  'TIA_VERIFICATION_PHASE',
] as const

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
  const saved = ESCAPING_VARIABLES.map(
    (name) => [name, process.env[name]] as const,
  )
  for (const name of ESCAPING_VARIABLES) delete process.env[name]
  const phases: PerfPhase[] = []
  const { spans } = yield* Effect.tryPromise({
    catch: (error) =>
      new TiaIo({
        cause: error,
        message: error instanceof Error ? error.message : String(error),
      }),
    try: () =>
      recordSpans(async () => {
        const cold = new TiaCore(options)
        await timed(phases, 'prepare (cold, no stored graph)', () =>
          cold.prepare(),
        )
        await timed(phases, `commit (${PERF_TEST_FILES} tests)`, () =>
          cold.commit(observations(), testFiles),
        )
        await writeFile(
          join(root, 'src', 'm0.mjs'),
          'export const value = -1\n',
        )
        const warm = new TiaCore(options)
        await timed(phases, 'prepare (warm, one source file changed)', () =>
          warm.prepare(),
        )
      }),
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
    ),
  )
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
