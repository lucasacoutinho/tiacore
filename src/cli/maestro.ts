import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'

import {
  output,
  outputPath,
  planFlags,
  planOptions,
  projectFlag,
  recordFlags,
  recordOptions,
  repeated,
  rootFlag,
} from './adapters.ts'
import { emitJson } from './io.ts'

/** The adapter's programs load on first use so `--help` and other commands stay fast. */
const programs = () =>
  Effect.promise(() => import('../runners/maestro/program.ts'))

const discovery = {
  excludeTag: repeated('exclude-tag', 'excluded flow tag; repeat as needed'),
  flows: Flag.String('flows').pipe(
    Flag.withDescription('Maestro flow directory'),
  ),
  includeTag: repeated('include-tag', 'included flow tag; repeat as needed'),
  output,
  project: projectFlag('suite project name'),
  root: rootFlag,
}

interface Discovery {
  readonly excludeTag: readonly string[]
  readonly flows: string
  readonly includeTag: readonly string[]
  readonly project: string
  readonly root: string
}

const where = (options: Discovery) => ({
  excludeTags: [...options.excludeTag],
  flows: options.flows,
  includeTags: [...options.includeTag],
  project: options.project,
  root: options.root,
})

const discoverCommand = Command.make(
  'discover',
  discovery,
  Effect.fn('tia.cli.maestro.discover')(function* (options) {
    const { discover } = yield* programs()
    yield* emitJson(yield* discover(where(options)), outputPath(options.output))
  }),
).pipe(Command.withDescription('Discover Maestro flows'))

const record = Command.make(
  'record',
  { ...discovery, ...recordFlags },
  Effect.fn('tia.cli.maestro.record')(function* (options) {
    const { createMaestroGraph, discover } = yield* programs()
    const suites = yield* discover(where(options))
    yield* emitJson(
      createMaestroGraph({ ...(yield* recordOptions(options)), suites }),
      outputPath(options.output),
    )
  }),
).pipe(Command.withDescription('Record a Maestro impact graph'))

const plan = Command.make(
  'plan',
  {
    ...discovery,
    ...planFlags('prior Maestro impact graph', 'force every flow'),
  },
  Effect.fn('tia.cli.maestro.plan')(function* (options) {
    const { discover, planSuites } = yield* programs()
    const suites = yield* discover(where(options))
    const result = yield* planSuites(suites, {
      ...where(options),
      ...(yield* planOptions(options, false)),
    })
    yield* emitJson(result, outputPath(options.output))
  }),
).pipe(Command.withDescription('Plan affected Maestro flows'))

export const maestroCommand = Command.make('maestro').pipe(
  Command.withDescription('Maestro adapter commands'),
  Command.withSubcommands([discoverCommand, record, plan]),
)
