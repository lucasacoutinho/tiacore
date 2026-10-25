import * as Command from 'effect/cli/Command'
import * as Effect from 'effect/Effect'

import {
  output,
  outputPath,
  planFlags,
  planOptions,
  projectFlag,
  repeated,
  rootFlag,
} from './adapters.ts'
import { emitJson } from './io.ts'

/** The adapter's programs load on first use so `--help` and other commands stay fast. */
const programs = () =>
  Effect.promise(() => import('../runners/gradle/program.ts'))

const discovery = {
  output,
  project: projectFlag('Gradle project name'),
  root: rootFlag,
  // Accepted for 1.x compatibility; only graph recording reads sources.
  source: repeated('source', 'production source glob; repeat as needed'),
  test: repeated('test', 'test source glob; repeat as needed'),
}

interface Discovery {
  readonly project: string
  readonly root: string
  readonly source: readonly string[]
  readonly test: readonly string[]
}

const where = (options: Discovery) => ({
  project: options.project,
  root: options.root,
  ...(options.source.length === 0 ? {} : { sources: [...options.source] }),
  ...(options.test.length === 0 ? {} : { tests: [...options.test] }),
})

const discoverCommand = Command.make(
  'discover',
  discovery,
  Effect.fn('tia.cli.gradle.discover')(function* (options) {
    const { discover } = yield* programs()
    yield* emitJson(yield* discover(where(options)), outputPath(options.output))
  }),
).pipe(Command.withDescription('Discover Gradle JUnit test classes'))

const plan = Command.make(
  'plan',
  {
    ...discovery,
    ...planFlags('prior Gradle impact graph', 'force every test class'),
  },
  Effect.fn('tia.cli.gradle.plan')(function* (options) {
    const { discover, planSuites } = yield* programs()
    const suites = yield* discover(where(options))
    const result = yield* planSuites(suites, {
      ...where(options),
      ...(yield* planOptions(options, true)),
    })
    yield* emitJson(result, outputPath(options.output))
  }),
).pipe(Command.withDescription('Plan affected Gradle JUnit test classes'))

export const gradleCommand = Command.make('gradle').pipe(
  Command.withDescription('Gradle/JUnit adapter commands'),
  Command.withSubcommands([discoverCommand, plan]),
)
