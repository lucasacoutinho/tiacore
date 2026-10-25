export {
  createFilesystemArtifactSink,
  tia,
  TiaArtifactPublisher,
} from '../engine/artifacts/publish.js'
export {
  createArtifactAttestation,
  parseArtifactAttestation,
  verifyArtifactAttestation,
} from '../engine/artifacts/trust.js'
export {
  TIA_ARTIFACT_ATTESTATION_VERSION,
  TIA_ARTIFACT_MANIFEST_VERSION,
} from '../engine/artifacts/types.js'
export type {
  TiaArtifactAttestationV1,
  TiaArtifactClaimV1,
  TiaArtifactLineage,
  TiaArtifactManifestEntry,
  TiaArtifactManifestV1,
  TiaArtifactPublishReceipt,
  TiaArtifactPublisherOptions,
  TiaArtifactSink,
  TiaArtifactSinkInput,
  TiaArtifactSinkResult,
  TiaArtifactSigningOptions,
  TiaArtifactTrustPolicy,
  TiaFilesystemArtifactSinkOptions,
} from '../engine/artifacts/types.js'
export type { TiaArtifactTrustResult } from '../engine/artifacts/trust.js'
