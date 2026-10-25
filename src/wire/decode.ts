import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { canonicalGraph } from '../core/canonical.ts'
import type { TiaArtifactEnvelope, TiaImpactGraph } from '../core/protocol.ts'
import { describeIssue } from './issue.ts'
import { ArtifactEnvelope, ImpactGraph } from './protocol.ts'

const strict = { onExcessProperty: 'error' } as const
const decodeGraph = Schema.decodeUnknownExit(ImpactGraph)
const decodeEnvelope = Schema.decodeUnknownExit(ArtifactEnvelope)

function valueOrThrow<A>(
  subject: string,
  exit: Exit.Exit<A, Schema.SchemaError>,
): A {
  if (Exit.isSuccess(exit)) return exit.value
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) throw Cause.squash(exit.cause)
  throw new Error(describeIssue(subject, error.value.issue))
}

/** Validates and canonicalizes a protocol v1 impact graph. */
export function parseImpactGraph(value: unknown): TiaImpactGraph {
  return canonicalGraph(
    valueOrThrow('TIA impact graph', decodeGraph(value, strict)),
  )
}

/** Validates an artifact envelope and canonicalizes its graph. */
export function parseArtifactEnvelope(value: unknown): TiaArtifactEnvelope {
  const envelope = valueOrThrow(
    'TIA artifact envelope',
    decodeEnvelope(value, strict),
  )
  return { ...envelope, graph: canonicalGraph(envelope.graph) }
}
