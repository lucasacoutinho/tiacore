import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { TiaExecutionPolicy } from '../core/protocol.ts'
import { createImpactPlan, mergeImpactGraphs } from '../engine/plan/protocol.ts'
import { parseImpactGraph } from '../wire/decode.ts'
import { TiaInvalid } from '../wire/errors.ts'
import { describeIssue } from '../wire/issue.ts'
import { SuiteDescriptor } from '../wire/protocol.ts'
import { attempt, emitJson, readJson } from './io.ts'

const ChangeSet = Schema.Union([
  Schema.mutable(Schema.Array(Schema.String)),
  Schema.Struct({
    files: Schema.mutable(Schema.Array(Schema.String)),
    provider: Schema.optionalKey(Schema.String),
  }),
])

const Policy = Schema.Struct({
  allowedSuites: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String)),
  ),
  expectedEnvironmentFingerprint: Schema.optionalKey(Schema.String),
  expectedFingerprint: Schema.optionalKey(Schema.String),
  forceFull: Schema.optionalKey(Schema.Boolean),
  ignoreChanges: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String)),
  ),
  onUnknownChange: Schema.optionalKey(Schema.Literals(['full', 'ignore'])),
})

function decodeWith<S extends Schema.Top>(schema: S, message: string) {
  const decode = Schema.decodeUnknownEffect(schema)
  return (value: unknown) =>
    decode(value).pipe(Effect.mapError(() => new TiaInvalid({ message })))
}

const decodeChanges = decodeWith(
  ChangeSet,
  'TIA change set must be a string array or an object with files',
)
const decodePolicy = decodeWith(Policy, 'TIA execution policy is invalid')
const decodeSuites = Schema.decodeUnknownEffect(
  Schema.mutable(Schema.Array(SuiteDescriptor)),
)
const decodeCatalog = (value: unknown) =>
  Array.isArray(value)
    ? decodeSuites(value).pipe(
        Effect.mapError(
          (error) =>
            new TiaInvalid({
              message: describeIssue('TIA suite catalog', error.issue),
            }),
        ),
      )
    : Effect.fail(
        new TiaInvalid({ message: 'TIA suite catalog must be an array' }),
      )

export const graphAt = Effect.fnUntraced(function* (path: string) {
  const value = yield* readJson(path)
  return yield* attempt(() => parseImpactGraph(value))
})

export const output = Flag.String('output').pipe(
  Flag.withDescription('write JSON to a file or -'),
  Flag.optional,
)

export const outputPath = (value: Option.Option<string>) =>
  Option.getOrUndefined(value)

const plan = Command.make(
  'plan',
  {
    catalog: Flag.String('catalog').pipe(
      Flag.withDescription('suite catalog JSON'),
    ),
    changes: Flag.String('changes').pipe(
      Flag.withDescription('changed paths JSON'),
    ),
    environmentFingerprint: Flag.String('environment-fingerprint').pipe(
      Flag.withDescription('current runner environment fingerprint'),
    ),
    fingerprint: Flag.String('fingerprint').pipe(
      Flag.withDescription('current project fingerprint'),
    ),
    forceFull: Flag.Boolean('force-full').pipe(
      Flag.withDescription('force a full plan'),
      Flag.withDefault(false),
    ),
    graph: Flag.String('graph').pipe(
      Flag.withDescription('prior impact graph JSON'),
      Flag.optional,
    ),
    output,
    policy: Flag.String('policy').pipe(
      Flag.withDescription('execution policy JSON'),
      Flag.optional,
    ),
  },
  Effect.fn('tia.cli.plan')(function* (options) {
    const policy: TiaExecutionPolicy = Option.isSome(options.policy)
      ? yield* decodePolicy(yield* readJson(options.policy.value))
      : {}
    if (options.forceFull) policy.forceFull = true
    const catalog = yield* decodeCatalog(yield* readJson(options.catalog))
    const changes = yield* decodeChanges(yield* readJson(options.changes))
    const graph = Option.isSome(options.graph)
      ? yield* graphAt(options.graph.value)
      : null
    const result = yield* attempt(() =>
      createImpactPlan({
        catalog,
        changes: Array.isArray(changes) ? { files: changes } : changes,
        currentEnvironmentFingerprint: options.environmentFingerprint,
        currentFingerprint: options.fingerprint,
        graph,
        policy,
      }),
    )
    yield* emitJson(result, outputPath(options.output))
  }),
).pipe(Command.withDescription('Create a runner-neutral impact plan'))

const merge = Command.make(
  'merge',
  {
    graph: Flag.String('graph').pipe(
      Flag.withDescription('graph JSON; repeat for every input'),
      Flag.atLeast(1),
    ),
    output,
  },
  Effect.fn('tia.cli.merge')(function* (options) {
    const graphs = yield* Effect.forEach(options.graph, graphAt)
    const merged = yield* attempt(() => mergeImpactGraphs(graphs))
    yield* emitJson(merged, outputPath(options.output))
  }),
).pipe(Command.withDescription('Merge runner-neutral impact graphs'))

const graphFlag = Flag.String('graph').pipe(
  Flag.withDescription('impact graph JSON'),
)

const inspect = Command.make(
  'inspect',
  { graph: graphFlag, output },
  Effect.fn('tia.cli.inspect')(function* (options) {
    const graph = yield* graphAt(options.graph)
    yield* emitJson(
      {
        adapters: [
          ...new Set(graph.suites.map((suite) => suite.adapter)),
        ].sort(),
        complete: graph.complete,
        environmentFingerprint: graph.environmentFingerprint,
        fingerprint: graph.fingerprint,
        observations: graph.observations.length,
        protocolVersion: graph.protocolVersion,
        suites: graph.suites.length,
      },
      outputPath(options.output),
    )
  }),
).pipe(Command.withDescription('Summarize a runner-neutral graph'))

/** `doctor` lives in doctor.ts: it validates a graph with --graph and checks the install without it. */
export const protocolCommands = [plan, merge, inspect] as const
