import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

import type { TiaReplayRunEvent } from '../../core/replay.ts'
import {
  TIA_VERIFICATION_SNAPSHOT_VERSION,
  type TiaPhaseSnapshot,
  type TiaVerificationPhase,
} from '../../core/verification.ts'
import { parseArtifactGraph } from '../../engine/artifacts/portable-graph.ts'
import { parseImpactGraph } from '../../wire/decode.ts'

const Strings = Schema.mutable(Schema.Array(Schema.String))

const Decision = Schema.Union([
  Schema.Struct({ reasons: Strings, target: Schema.Literal('run') }),
  Schema.Struct({
    file: Schema.String,
    id: Schema.String,
    reasons: Strings,
    target: Schema.Literal('test-case'),
  }),
  Schema.Struct({
    file: Schema.String,
    reasons: Strings,
    target: Schema.Literal('test-file'),
  }),
])

const Plan: Schema.Codec<TiaReplayRunEvent> = Schema.Struct({
  affectedTestIds: Strings,
  affectedTests: Strings,
  baseline: Schema.Struct({
    artifactId: Schema.optionalKey(
      Schema.Union([
        Schema.Finite,
        Schema.String,
        Schema.mutable(
          Schema.Array(Schema.Union([Schema.Finite, Schema.String])),
        ),
      ]),
    ),
    origin: Schema.Literals(['artifact', 'local', 'none']),
    provider: Schema.optionalKey(Schema.String),
    reason: Schema.String,
    sha: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.Literals(['filesystem', 'git'])),
  }),
  changedFiles: Strings,
  decisions: Schema.mutable(Schema.Array(Decision)),
  mode: Schema.Literals(['record', 'replay']),
  reason: Schema.String,
  replayedTests: Schema.Finite,
  wholeTestFiles: Strings,
})

const Phase = Schema.Literals(['full', 'selective'])

const Envelope = Schema.Struct({
  executedTestIds: Strings,
  generatedAt: Schema.String,
  graph: Schema.Unknown,
  kind: Schema.optionalKey(Schema.Literal('runtime')),
  phase: Phase,
  plan: Plan,
  runner: Schema.NonEmptyString,
  schema: Schema.Literal(TIA_VERIFICATION_SNAPSHOT_VERSION),
  success: Schema.Boolean,
})

const ProtocolEnvelope = Schema.Struct({
  executedTestIds: Strings,
  generatedAt: Schema.String,
  graph: Schema.Unknown,
  kind: Schema.Literal('protocol'),
  phase: Phase,
  plan: Schema.Struct({
    cached: Strings,
    changedFiles: Strings,
    mode: Schema.Literals(['full', 'selective', 'skip']),
    protocolVersion: Schema.Literal(1),
    reason: Schema.String,
    reasons: Schema.Record(Schema.String, Strings),
    resourceLocks: Strings,
    selected: Strings,
  }),
  runner: Schema.NonEmptyString,
  schema: Schema.Literal(TIA_VERIFICATION_SNAPSHOT_VERSION),
  success: Schema.Boolean,
  suiteOutcomes: Schema.Record(
    Schema.String,
    Schema.Literals(['failed', 'passed', 'unknown']),
  ),
})

const decodeEnvelope = Schema.decodeUnknownExit(Envelope)
const decodeProtocolEnvelope = Schema.decodeUnknownExit(ProtocolEnvelope)

function protocolGraph(value: unknown) {
  try {
    return parseImpactGraph(value)
  } catch {
    return null
  }
}

function isProtocol(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'protocol'
  )
}

/**
 * The snapshot a runner wrote for `phase`, or null when the value is not one.
 * A test-granular runner embeds a runtime graph, parsed like an artifact
 * graph, so a portable schema-3 graph is compacted into the runtime layout. A
 * suite-granular runner (`kind: 'protocol'`) embeds a protocol impact graph,
 * validated like any other.
 */
export function readSnapshot(
  value: unknown,
  phase: TiaVerificationPhase,
): TiaPhaseSnapshot | null {
  if (isProtocol(value)) {
    const decoded = decodeProtocolEnvelope(value)
    if (Exit.isFailure(decoded) || decoded.value.phase !== phase) return null
    const graph = protocolGraph(decoded.value.graph)
    return graph === null ? null : { ...decoded.value, graph }
  }
  const decoded = decodeEnvelope(value)
  if (Exit.isFailure(decoded) || decoded.value.phase !== phase) return null
  const graph = parseArtifactGraph(decoded.value.graph)
  return graph === null ? null : { ...decoded.value, graph }
}
