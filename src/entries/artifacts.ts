export {
  createFilesystemArtifactSink,
  tia,
  TiaArtifactPublisher,
} from '../engine/artifacts/publish.ts'
export {
  createArtifactAttestation,
  parseArtifactAttestation,
  verifyArtifactAttestation,
} from '../engine/artifacts/trust.ts'
export {
  TIA_ARTIFACT_ATTESTATION_VERSION,
  TIA_ARTIFACT_MANIFEST_VERSION,
} from '../core/artifacts.ts'
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
} from '../core/artifacts.ts'
export type { TiaArtifactTrustResult } from '../engine/artifacts/trust.ts'
