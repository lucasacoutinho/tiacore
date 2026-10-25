import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_ARTIFACT_LIST,
  MAX_ARTIFACT_TEXT,
  TIA_ARTIFACT_ATTESTATION_VERSION,
  TIA_ARTIFACT_MANIFEST_VERSION,
  type TiaArtifactAttestationV1,
  type TiaArtifactId,
  type TiaArtifactLineage,
} from '../../core/artifacts.ts'

// Decoders for the two documents that cross a trust boundary: the attestation
// in an archive and the manifest an HTTP provider serves. They follow
// docs/protocol/schemas/tiacore-artifact-{attestation,manifest}-v1.schema.json exactly:
// unknown fields are invalid, identifiers are bounded at 8192 characters, a
// lineage names at most 100 distinct parents. Timestamps need to parse as
// dates; the schema's `date-time` format is not tightened further.

const strict = { onExcessProperty: 'error' } as const

/** The characters and length a signing key id may have. */
export const KEY_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,512}$/u

const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ARTIFACT_TEXT),
)
const Identifier = Schema.Union([Schema.Int, Text])
const Timestamp = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      Number.isFinite(Date.parse(value)) || 'must be a date-time',
  ),
)
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Source = Schema.Literals(['filesystem', 'git'])

const Parents = Schema.mutable(Schema.Array(Identifier)).check(
  Schema.isMaxLength(MAX_ARTIFACT_LIST),
  Schema.makeFilter(
    (parents: readonly TiaArtifactId[]) =>
      new Set(parents).size === parents.length || 'contains duplicate values',
  ),
)

const Lineage = Schema.Struct({
  baseline: Schema.Struct({
    sha: Text,
    source: Schema.optionalKey(Source),
  }),
  parents: Parents,
  producedAt: Timestamp,
  producer: Schema.optionalKey(Text),
  runId: Text,
})

const Attestation = Schema.Struct({
  algorithm: Schema.Literal('Ed25519'),
  claim: Schema.Struct({
    expiresAt: Timestamp,
    fingerprint: Text,
    graphSha256: Sha256,
    issuedAt: Timestamp,
    lineage: Lineage,
    promoted: Schema.Boolean,
    runner: Schema.optionalKey(Text),
  }),
  keyId: Schema.String.check(Schema.isPattern(KEY_ID_PATTERN)),
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86}$/u)),
  version: Schema.Literal(TIA_ARTIFACT_ATTESTATION_VERSION),
})

const ManifestEntry = Schema.Struct({
  fingerprint: Schema.optionalKey(Text),
  group: Schema.optionalKey(Identifier),
  id: Identifier,
  lineage: Schema.optionalKey(Lineage),
  promoted: Schema.optionalKey(Schema.Boolean),
  runner: Schema.optionalKey(Text),
  sha256: Schema.optionalKey(Sha256),
  size: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ maximum: MAX_ARTIFACT_ARCHIVE_BYTES, minimum: 0 }),
    ),
  ),
  url: Text,
})

const Manifest = Schema.Struct({
  artifacts: Schema.mutable(Schema.Array(ManifestEntry)).check(
    Schema.isMaxLength(MAX_ARTIFACT_LIST),
  ),
  generatedAt: Schema.optionalKey(Timestamp),
  version: Schema.Literal(TIA_ARTIFACT_MANIFEST_VERSION),
})

/** A manifest entry as a consumer reads it: only `id` and `url` are required. */
export interface ManifestEntryV1 {
  fingerprint?: string
  group?: TiaArtifactId
  id: TiaArtifactId
  lineage?: TiaArtifactLineage
  promoted?: boolean
  runner?: string
  sha256?: string
  size?: number
  url: string
}

export interface ManifestDocument {
  artifacts: ManifestEntryV1[]
  generatedAt?: string
  version: typeof TIA_ARTIFACT_MANIFEST_VERSION
}

function valueOrNull<A>(exit: Exit.Exit<A, unknown>): A | null {
  return Exit.isSuccess(exit) ? exit.value : null
}

const decodeAttestation = Schema.decodeUnknownExit(Attestation)
const decodeManifest = Schema.decodeUnknownExit(Manifest)

/**
 * The attestation when `value` is a well-formed v1 document, else null. Extra
 * fields, over-long identifiers and more than 100 parents make it malformed.
 */
export function readAttestation(
  value: unknown,
): TiaArtifactAttestationV1 | null {
  return valueOrNull(decodeAttestation(value, strict))
}

/** The manifest when `value` is a well-formed v1 document, else null. */
export function readManifest(value: unknown): ManifestDocument | null {
  return valueOrNull(decodeManifest(value, strict))
}
