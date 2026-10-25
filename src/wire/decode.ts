import * as Schema from 'effect/Schema'

import { canonicalGraph } from '../core/canonical.ts'
import type { TiaArtifactEnvelope, TiaImpactGraph } from '../core/protocol.ts'
import { acceptImpactGraph } from './impact-graph-guard.ts'
import { valueOrThrow } from './issue.ts'
import { ArtifactEnvelope, ImpactGraph } from './protocol.ts'

const strict = { onExcessProperty: 'error' } as const
const decodeGraph = Schema.decodeUnknownExit(ImpactGraph)
const decodeEnvelope = Schema.decodeUnknownExit(ArtifactEnvelope)

/**
 * Validates and canonicalizes a protocol v1 impact graph. A valid graph takes
 * the fast guard; the Schema decides and explains everything else.
 */
export function parseImpactGraph(value: unknown): TiaImpactGraph {
  return canonicalGraph(
    acceptImpactGraph(value) ??
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
