// Public types of the provider-neutral graph artifacts: the attestation and
// manifest documents (spec/artifact-*-v1.md), the publisher, sinks, and the
// provider contract users implement. Plain interfaces and Promise methods; the
// engine lifts them into Effect.

import { byCodeUnit } from './canonical.ts'

export const TIA_ARTIFACT_ATTESTATION_VERSION = 1 as const
export const TIA_ARTIFACT_MANIFEST_VERSION = 1 as const

export interface TiaGitHubActionsOptions {
  apiUrl?: string
  artifactName?: string
  branch?: string
  maxArtifacts?: number
  repository?: string
  runId?: number | string
  tokenEnv?: string
}

export interface TiaFilesystemArtifactOptions {
  group?: string
  paths?: string[]
}

export interface TiaHttpManifestOptions {
  authorizationScheme?: string
  maxArtifacts?: number
  name?: string
  promotedOnly?: boolean
  tokenEnv?: string
  url: string
}

export type TiaArtifactId = number | string

export interface TiaArtifactLineage {
  baseline: {
    sha: string
    source?: 'filesystem' | 'git'
  }
  parents: TiaArtifactId[]
  producedAt: string
  producer?: string
  runId: string
}

export interface TiaArtifactClaimV1 {
  expiresAt: string
  fingerprint: string
  graphSha256: string
  issuedAt: string
  lineage: TiaArtifactLineage
  promoted: boolean
  runner?: string
}

export interface TiaArtifactAttestationV1 {
  algorithm: 'Ed25519'
  claim: TiaArtifactClaimV1
  keyId: string
  signature: string
  version: typeof TIA_ARTIFACT_ATTESTATION_VERSION
}

export interface TiaArtifactSigningOptions {
  expiresInSeconds?: number
  keyId: string
  privateKey: string
}

export interface TiaArtifactTrustPolicy {
  allowUnsigned?: boolean
  allowedBaselineSources?: Array<'filesystem' | 'git'>
  allowedProducers?: string[]
  maxAgeSeconds?: number
  notBefore?: string
  publicKeys?: Record<string, string>
  requirePromoted?: boolean
}

export interface TiaArtifactManifestEntry {
  fingerprint: string
  group?: TiaArtifactId
  id: TiaArtifactId
  lineage: TiaArtifactLineage
  promoted: boolean
  runner?: string
  sha256: string
  size: number
  url: string
}

export interface TiaArtifactManifestV1 {
  artifacts: TiaArtifactManifestEntry[]
  generatedAt: string
  version: typeof TIA_ARTIFACT_MANIFEST_VERSION
}

export interface TiaArtifactSinkInput {
  body: Uint8Array
  contentType: 'application/json' | 'application/zip'
  key: string
  sha256: string
}

export interface TiaArtifactSinkResult {
  id?: TiaArtifactId
  url: string
}

export interface TiaArtifactSink {
  name: string
  put(
    input: TiaArtifactSinkInput,
  ): Promise<TiaArtifactSinkResult> | TiaArtifactSinkResult
}

export interface TiaFilesystemArtifactSinkOptions {
  baseUrl?: string
  directory?: string
}

export interface TiaArtifactPublisherOptions {
  artifactId: TiaArtifactId
  cacheDir?: string
  filesystem?: TiaFilesystemArtifactSinkOptions
  group?: TiaArtifactId
  parents?: TiaArtifactId[]
  producer?: string
  requireCoverage?: boolean
  root?: string
  runId: string
  runner?: string
  sink?: TiaArtifactSink
  signing: TiaArtifactSigningOptions
}

export interface TiaArtifactPublishReceipt {
  artifactId: TiaArtifactId
  artifactUrl: string
  baselineSha: string
  bytes: number
  fingerprint: string
  keyId: string
  manifestUrl: string
  promoted: boolean
  sha256: string
  sink: string
  trustExpiresAt: string
}

export interface TiaGitLabCiOptions {
  apiUrl?: string
  branch?: string
  jobName?: string
  maxPipelines?: number
  pipelineId?: number | string
  projectId?: number | string
  tokenHeader?: 'JOB-TOKEN' | 'PRIVATE-TOKEN'
  tokenEnv?: string
}

export interface TiaArtifactProviderContext {
  fingerprint: string
  root?: string
  runner?: string
}

export interface TiaArtifactCandidate {
  attestation?: TiaArtifactAttestationV1
  graph: string | unknown
  graphSha256?: string
  group?: number | string
  id: TiaArtifactId
}

export interface TiaArtifactProvider {
  name: string
  load(
    context: TiaArtifactProviderContext,
  ):
    | Promise<TiaArtifactCandidate | TiaArtifactCandidate[] | null>
    | TiaArtifactCandidate
    | TiaArtifactCandidate[]
    | null
}

export type TiaArtifactSource =
  | TiaArtifactProvider
  | ({ provider: 'filesystem' } & TiaFilesystemArtifactOptions)
  | ({ provider: 'github-actions' } & TiaGitHubActionsOptions)
  | ({ provider: 'gitlab-ci' } & TiaGitLabCiOptions)
  | ({ provider: 'http-manifest' } & TiaHttpManifestOptions)

/** Largest zip a producer may write or a consumer will read. */
export const MAX_ARTIFACT_ARCHIVE_BYTES = 25 * 1024 * 1024
/** Largest `graph.json` (and any other extracted entry). */
export const MAX_ARTIFACT_GRAPH_BYTES = 20 * 1024 * 1024
/** Largest HTTP manifest a consumer reads. */
export const MAX_MANIFEST_BYTES = 1024 * 1024
/** Bound shared by every identifier in the attestation and manifest schemas. */
export const MAX_ARTIFACT_TEXT = 8_192
/** Most parents a lineage may name, and most entries a manifest may list. */
export const MAX_ARTIFACT_LIST = 100

/** Whether `value` fits the schemas' identifier type: a safe integer or bounded text. */
export function isArtifactIdentifier(value: unknown): value is TiaArtifactId {
  return typeof value === 'number'
    ? Number.isSafeInteger(value)
    : typeof value === 'string' &&
        value !== '' &&
        value.length <= MAX_ARTIFACT_TEXT
}

const UNSAFE_SEGMENT = /^\.\.$/u
const DRIVE_LETTER = /^[A-Za-z]:/u

/**
 * Whether `value` is a relative path that cannot leave the directory it is
 * joined to: non-empty, no NUL or backslash, not absolute or drive-qualified,
 * and no `..` segment. Used for archive entry names, sink keys and runner
 * namespaces, so a traversal is rejected wherever a name can become a path.
 */
export function isSafeRelativePath(value: string): boolean {
  if (
    value === '' ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    DRIVE_LETTER.test(value)
  ) {
    return false
  }
  return !value.split('/').some((segment) => UNSAFE_SEGMENT.test(segment))
}

/**
 * The runner namespace rule 1.x enforced: also refuses `..` anywhere in the
 * text, not only as a segment.
 */
export function isSafeRunner(value: string): boolean {
  return isSafeRelativePath(value) && !value.includes('..')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => byCodeUnit(left, right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

/**
 * The bytes an attestation signature covers: the compact JSON of the
 * attestation without `signature`, object keys sorted at every depth in
 * UTF-16 code-unit order, arrays in their given order.
 */
export function attestationPayload(
  attestation: Omit<TiaArtifactAttestationV1, 'signature'>,
): string {
  return JSON.stringify(canonical(attestation))
}

export interface RestoreArtifactsInput {
  cacheDir: string
  coverageRequested?: boolean
  fingerprint: string
  log: boolean
  providers: TiaArtifactProvider[]
  root?: string
  runner?: string
  /** Defaults to `{}`: unsigned artifacts are rejected unless `allowUnsigned`. */
  trust?: TiaArtifactTrustPolicy
}

export interface RestoreArtifactResult {
  artifactId?: Array<number | string> | number | string
  provider?: string
  reason: string
  restored: boolean
  trust?: {
    keyId?: string
    reason: string
  }
}
