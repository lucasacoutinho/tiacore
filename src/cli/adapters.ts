import * as Effect from 'effect/Effect'
import * as Flag from 'effect/cli/Flag'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type {
  TiaDependencyObservation,
  TiaInvalidator,
} from '../core/protocol.ts'
import { parseImpactGraph } from '../wire/decode.ts'
import { TiaInvalid } from '../wire/errors.ts'
import { describeIssue } from '../wire/issue.ts'
import { DependencyObservation, Invalidator } from '../wire/protocol.ts'
import { attempt, readJson } from './io.ts'

const ChangeSet = Schema.Union([
  Schema.mutable(Schema.Array(Schema.String)),
  Schema.Struct({ files: Schema.mutable(Schema.Array(Schema.String)) }),
])
const decodeChangeSet = Schema.decodeUnknownEffect(ChangeSet)

const GraphOptionsFile = Schema.Struct({
  invalidators: Schema.optionalKey(Schema.mutable(Schema.Array(Invalidator))),
  knownSources: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  observations: Schema.optionalKey(
    Schema.mutable(Schema.Array(DependencyObservation)),
  ),
})
const decodeGraphOptions = Schema.decodeUnknownEffect(GraphOptionsFile)

export const output = Flag.String('output').pipe(
  Flag.withDescription('write JSON to a file or -'),
  Flag.optional,
)

export const outputPath = (value: Option.Option<string>): string | undefined =>
  Option.getOrUndefined(value)

/** A flag that may repeat; absent means an empty list. */
export const repeated = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.atLeast(0))

export const rootFlag = Flag.String('root').pipe(
  Flag.withDescription('repository root'),
)

export const projectFlag = (description: string) =>
  Flag.String('project').pipe(Flag.withDescription(description))

const environmentFingerprintFlag = Flag.String('environment-fingerprint').pipe(
  Flag.withDescription('runner environment fingerprint'),
)

const fingerprintFlag = Flag.String('fingerprint').pipe(
  Flag.withDescription('project fingerprint'),
  Flag.optional,
)

export const planFlags = (
  graphDescription: string,
  fullDescription: string,
) => ({
  changes: Flag.String('changes').pipe(
    Flag.withDescription('changed paths JSON'),
  ),
  environmentFingerprint: environmentFingerprintFlag,
  fingerprint: fingerprintFlag,
  forceFull: Flag.Boolean('force-full').pipe(
    Flag.withDescription(fullDescription),
    Flag.withDefault(false),
  ),
  graph: Flag.String('graph').pipe(
    Flag.withDescription(graphDescription),
    Flag.optional,
  ),
  ignoreChange: repeated(
    'ignore-change',
    'ignored changed path; repeat as needed',
  ),
  ignoreUnknown: Flag.Boolean('ignore-unknown').pipe(
    Flag.withDescription('ignore unknown changed paths'),
    Flag.withDefault(false),
  ),
})

export const recordFlags = {
  environmentFingerprint: environmentFingerprintFlag,
  fingerprint: fingerprintFlag,
  graphOptions: Flag.String('graph-options').pipe(
    Flag.withDescription('graph options JSON'),
    Flag.optional,
  ),
}

/** The changed paths of a change set file: a string array or `{ files }`. */
export const readChanges = Effect.fnUntraced(function* (path: string) {
  const value = yield* readJson(path)
  const changes = yield* decodeChangeSet(value).pipe(
    Effect.mapError(
      () =>
        new TiaInvalid({
          message:
            'TIA change set must be a string array or an object with files',
        }),
    ),
  )
  return Array.isArray(changes) ? changes : changes.files
})

export const readGraph = Effect.fnUntraced(function* (path: string) {
  const value = yield* readJson(path)
  return yield* attempt(() => parseImpactGraph(value))
})

export const optionalGraph = Effect.fnUntraced(function* (
  path: Option.Option<string>,
) {
  return Option.isSome(path) ? yield* readGraph(path.value) : null
})

export interface GraphKnowledge {
  invalidators: TiaInvalidator[]
  knownSources: string[]
  observations: TiaDependencyObservation[]
}

/** What `record --graph-options` adds to a recorded graph; other keys are ignored. */
export const readGraphKnowledge = Effect.fnUntraced(function* (
  path: Option.Option<string>,
) {
  if (Option.isNone(path)) {
    return { invalidators: [], knownSources: [], observations: [] }
  }
  const value = yield* readJson(path.value)
  const decoded = yield* decodeGraphOptions(value).pipe(
    Effect.mapError(
      (error) =>
        new TiaInvalid({
          message: describeIssue('graph options', error.issue),
        }),
    ),
  )
  return {
    invalidators: decoded.invalidators ?? [],
    knownSources: decoded.knownSources ?? [],
    observations: decoded.observations ?? [],
  } satisfies GraphKnowledge
})
