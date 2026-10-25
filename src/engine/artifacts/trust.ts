import { sign, verify } from 'node:crypto'

import {
  attestationPayload,
  TIA_ARTIFACT_ATTESTATION_VERSION,
  type TiaArtifactAttestationV1,
  type TiaArtifactClaimV1,
  type TiaArtifactSigningOptions,
  type TiaArtifactTrustPolicy,
} from '../../core/artifacts.ts'
import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { parsePrivateKey, parsePublicKey } from './keys.ts'
import { readAttestation } from './schema.ts'

const KEY_ID = /^[A-Za-z0-9._:@/-]{1,512}$/u
const CLOCK_SKEW_MS = 5 * 60_000

export function isKeyId(value: string): boolean {
  return KEY_ID.test(value)
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The attestation when `value` is a well-formed v1 document, else null. The
 * result is a copy: unknown fields, over-long identifiers and more than 100
 * parents make a document malformed, as the committed JSON Schema says.
 */
export function parseArtifactAttestation(
  value: unknown,
): TiaArtifactAttestationV1 | null {
  return readAttestation(value)
}

export function createArtifactAttestation(
  claim: TiaArtifactClaimV1,
  options: TiaArtifactSigningOptions,
): TiaArtifactAttestationV1 {
  if (!isKeyId(options.keyId)) {
    throw new Error('TIA artifact signing key id is invalid')
  }
  const unsigned = {
    algorithm: 'Ed25519' as const,
    claim,
    keyId: options.keyId,
    version: TIA_ARTIFACT_ATTESTATION_VERSION,
  }
  let privateKey
  try {
    privateKey = parsePrivateKey(options.privateKey)
  } catch {
    throw new Error('TIA artifact signing key is not a valid private key')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('TIA artifact signing key must be Ed25519')
  }
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(attestationPayload(unsigned)),
      privateKey,
    ).toString('base64url'),
  }
}

export interface TiaArtifactTrustResult {
  keyId?: string
  reason: string
  trusted: boolean
}

export interface VerifyArtifactInput {
  attestation: unknown
  graph: TiaRuntimeGraph
  graphSha256?: string
  now?: Date
  policy?: TiaArtifactTrustPolicy
  runner?: string
}

/**
 * Decides whether an artifact may be used as a baseline. The checks run in the
 * order spec/artifact-attestation-v1.md lists them, and the first failure
 * names the reason: signature, graph digest, graph identity, runner, validity
 * window, then the trust policy.
 */
export function verifyArtifactAttestation(
  input: VerifyArtifactInput,
): TiaArtifactTrustResult {
  const policy = input.policy ?? {}
  const attestation = parseArtifactAttestation(input.attestation)
  if (attestation === null) {
    return policy.allowUnsigned === true
      ? { reason: 'unsigned artifacts explicitly allowed', trusted: true }
      : { reason: 'artifact has no valid attestation', trusted: false }
  }

  const { claim, keyId } = attestation
  const reject = (reason: string): TiaArtifactTrustResult => ({
    keyId,
    reason,
    trusted: false,
  })

  const publicKey = policy.publicKeys?.[keyId]
  if (publicKey === undefined) {
    return reject(`artifact key is not trusted: ${keyId}`)
  }
  let key
  try {
    key = parsePublicKey(publicKey)
  } catch {
    return reject(`trusted artifact key is invalid: ${keyId}`)
  }
  const { signature, ...unsigned } = attestation
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(
      null,
      Buffer.from(attestationPayload(unsigned)),
      key,
      Buffer.from(signature, 'base64url'),
    )
  ) {
    return reject('artifact signature is invalid')
  }

  if (
    input.graphSha256 === undefined ||
    claim.graphSha256 !== input.graphSha256
  ) {
    return reject('artifact graph digest does not match its attestation')
  }
  if (
    claim.fingerprint !== input.graph.fingerprint ||
    claim.lineage.baseline.sha !== input.graph.baseline.sha ||
    claim.lineage.baseline.source !== input.graph.baseline.source
  ) {
    return reject('artifact graph identity does not match its attestation')
  }
  if (input.runner !== undefined && claim.runner !== input.runner) {
    return reject('artifact runner does not match its attestation')
  }

  const now = (input.now ?? new Date()).getTime()
  const issuedAt = timestamp(claim.issuedAt) ?? Number.NaN
  const expiresAt = timestamp(claim.expiresAt) ?? Number.NaN
  if (issuedAt > now + CLOCK_SKEW_MS) {
    return reject('artifact attestation is not valid yet')
  }
  if (expiresAt <= now) {
    return reject('artifact attestation has expired')
  }
  if (expiresAt <= issuedAt) {
    return reject('artifact attestation has an invalid validity window')
  }

  if (
    policy.maxAgeSeconds !== undefined &&
    now - issuedAt > policy.maxAgeSeconds * 1_000
  ) {
    return reject('artifact attestation exceeds the allowed age')
  }
  if (
    policy.notBefore !== undefined &&
    issuedAt < (timestamp(policy.notBefore) ?? Number.POSITIVE_INFINITY)
  ) {
    return reject('artifact predates the trust policy')
  }
  if (policy.requirePromoted === true && !claim.promoted) {
    return reject('artifact is not a promoted baseline')
  }
  if (
    policy.allowedProducers !== undefined &&
    (claim.lineage.producer === undefined ||
      !policy.allowedProducers.includes(claim.lineage.producer))
  ) {
    return reject('artifact producer is not trusted')
  }
  if (
    policy.allowedBaselineSources !== undefined &&
    (claim.lineage.baseline.source === undefined ||
      !policy.allowedBaselineSources.includes(claim.lineage.baseline.source))
  ) {
    return reject('artifact baseline source is not trusted')
  }

  return {
    keyId,
    reason: 'artifact signature and trust policy verified',
    trusted: true,
  }
}
