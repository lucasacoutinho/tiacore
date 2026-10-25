import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { createGraph, discover, planSuites } from '../runners/k6/program.ts'
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
  output,
  profiles: Flag.String('profiles').pipe(
    Flag.withDescription('k6 profile directory'),
  ),
  project: projectFlag('suite project name'),
  root: rootFlag,
}

interface Discovery {
  readonly profiles: string
  readonly project: string
  readonly root: string
}

const where = (options: Discovery) => ({
  profiles: options.profiles,
  project: options.project,
  root: options.root,
})

const discoverCommand = Command.make(
  'discover',
  discovery,
  Effect.fn('tia.cli.k6.discover')(function* (options) {
    yield* emitJson(yield* discover(where(options)), outputPath(options.output))
  }),
).pipe(Command.withDescription('Discover k6 profiles'))

const record = Command.make(
  'record',
  { ...discovery, ...recordFlags },
  Effect.fn('tia.cli.k6.record')(function* (options) {
    const suites = yield* discover(where(options))
    const knowledge = yield* readGraphKnowledge(options.graphOptions)
    const graph = yield* createGraph(options.root, {
      environmentFingerprint: options.environmentFingerprint,
      ...(Option.isSome(options.fingerprint)
        ? { fingerprint: options.fingerprint.value }
        : {}),
      ...knowledge,
      suites,
    })
    yield* emitJson(graph, outputPath(options.output))
  }),
).pipe(Command.withDescription('Record a k6 impact graph'))

const plan = Command.make(
  'plan',
  {
    ...discovery,
    ...planFlags('prior k6 impact graph', 'force every profile'),
    allowedProfile: repeated(
      'allowed-profile',
      'allowed profile ID; repeat as needed',
    ),
  },
  Effect.fn('tia.cli.k6.plan')(function* (options) {
    const suites = yield* discover(where(options))
    const result = yield* planSuites(suites, {
      ...where(options),
      ...(options.allowedProfile.length === 0
        ? {}
        : { allowedProfiles: [...options.allowedProfile] }),
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
).pipe(Command.withDescription('Plan affected k6 profiles'))

export const k6Command = Command.make('k6').pipe(
  Command.withDescription('k6 adapter commands'),
  Command.withSubcommands([discoverCommand, record, plan]),
)
