import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import {
  createMaestroGraph,
  discover,
  planSuites,
} from '../runners/maestro/program.ts'
import {
  optionalGraph,
  output,
  outputPath,
  planFlags,
  projectFlag,
  readChanges,
  readGraphKnowledge,
  recordFlags,
  repeated,
  rootFlag,
} from './adapters.ts'
import { emitJson } from './io.ts'

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
    yield* emitJson(yield* discover(where(options)), outputPath(options.output))
  }),
).pipe(Command.withDescription('Discover Maestro flows'))

const record = Command.make(
  'record',
  { ...discovery, ...recordFlags },
  Effect.fn('tia.cli.maestro.record')(function* (options) {
    const suites = yield* discover(where(options))
    const knowledge = yield* readGraphKnowledge(options.graphOptions)
    yield* emitJson(
      createMaestroGraph({
        environmentFingerprint: options.environmentFingerprint,
        ...(Option.isSome(options.fingerprint)
          ? { fingerprint: options.fingerprint.value }
          : {}),
        ...knowledge,
        suites,
      }),
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
    const suites = yield* discover(where(options))
    const result = yield* planSuites(suites, {
      ...where(options),
      changes: yield* readChanges(options.changes),
      currentEnvironmentFingerprint: options.environmentFingerprint,
      ...(Option.isSome(options.fingerprint)
        ? { currentFingerprint: options.fingerprint.value }
        : {}),
      forceFull: options.forceFull,
      graph: yield* optionalGraph(options.graph),
      ignoreChanges: [...options.ignoreChange],
      onUnknownChange: options.ignoreUnknown ? 'ignore' : 'full',
    })
    yield* emitJson(result, outputPath(options.output))
  }),
).pipe(Command.withDescription('Plan affected Maestro flows'))

export const maestroCommand = Command.make('maestro').pipe(
  Command.withDescription('Maestro adapter commands'),
  Command.withSubcommands([discoverCommand, record, plan]),
)
