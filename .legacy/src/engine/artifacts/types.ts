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
