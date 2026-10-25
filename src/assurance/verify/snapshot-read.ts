import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

import type { TiaReplayRunEvent } from '../../core/replay.ts'
import {
  TIA_VERIFICATION_SNAPSHOT_VERSION,
  type TiaVerificationPhase,
  type TiaVerificationSnapshot,
} from '../../core/verification.ts'
import { parseArtifactGraph } from '../../engine/artifacts/portable-graph.ts'

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

const Envelope = Schema.Struct({
  executedTestIds: Strings,
  generatedAt: Schema.String,
  graph: Schema.Unknown,
  phase: Schema.Literals(['full', 'selective']),
  plan: Plan,
  runner: Schema.NonEmptyString,
  schema: Schema.Literal(TIA_VERIFICATION_SNAPSHOT_VERSION),
  success: Schema.Boolean,
})

const decodeEnvelope = Schema.decodeUnknownExit(Envelope)

/**
 * The snapshot a runner wrote for `phase`, or null when the value is not one.
 * The embedded graph is parsed like an artifact graph, so a portable schema-3
 * graph is compacted into the runtime layout.
 */
export function readSnapshot(
  value: unknown,
  phase: TiaVerificationPhase,
): TiaVerificationSnapshot | null {
  const decoded = decodeEnvelope(value)
  if (Exit.isFailure(decoded) || decoded.value.phase !== phase) return null
  const graph = parseArtifactGraph(decoded.value.graph)
  return graph === null ? null : { ...decoded.value, graph }
}
