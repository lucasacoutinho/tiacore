import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'

import type { TiaRuntimeGraph } from '../types.js'
import {
  TIA_ARTIFACT_ATTESTATION_VERSION,
  type TiaArtifactAttestationV1,
  type TiaArtifactClaimV1,
  type TiaArtifactSigningOptions,
  type TiaArtifactTrustPolicy,
} from './types.js'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([key, item]) => [key, canonical(item)]),
  )
}

function payload(attestation: Omit<TiaArtifactAttestationV1, 'signature'>): Buffer {
  return Buffer.from(JSON.stringify(canonical(attestation)))
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,512}$/

function validClaim(value: unknown): value is TiaArtifactClaimV1 {
  if (value === null || typeof value !== 'object') return false
  const claim = value as Partial<TiaArtifactClaimV1>
  return (
    typeof claim.expiresAt === 'string' &&
    timestamp(claim.expiresAt) !== null &&
    typeof claim.fingerprint === 'string' &&
    claim.fingerprint !== '' &&
    typeof claim.graphSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(claim.graphSha256) &&
    typeof claim.issuedAt === 'string' &&
    timestamp(claim.issuedAt) !== null &&
    claim.lineage !== null &&
    typeof claim.lineage === 'object' &&
    typeof claim.lineage.baseline?.sha === 'string' &&
    claim.lineage.baseline.sha !== '' &&
    Array.isArray(claim.lineage.parents) &&
    typeof claim.lineage.producedAt === 'string' &&
    typeof claim.lineage.runId === 'string' &&
    typeof claim.promoted === 'boolean' &&
    (claim.runner === undefined || typeof claim.runner === 'string')
  )
}

export function parseArtifactAttestation(
  value: unknown,
): TiaArtifactAttestationV1 | null {
  if (value === null || typeof value !== 'object') return null
  const attestation = value as Partial<TiaArtifactAttestationV1>
  if (
    attestation.version !== TIA_ARTIFACT_ATTESTATION_VERSION ||
    attestation.algorithm !== 'Ed25519' ||
    typeof attestation.keyId !== 'string' ||
    !KEY_ID_PATTERN.test(attestation.keyId) ||
    typeof attestation.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(attestation.signature) ||
    !validClaim(attestation.claim)
  ) {
    return null
  }
  return attestation as TiaArtifactAttestationV1
}

export function createArtifactAttestation(
  claim: TiaArtifactClaimV1,
  options: TiaArtifactSigningOptions,
): TiaArtifactAttestationV1 {
  if (!KEY_ID_PATTERN.test(options.keyId)) {
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
    privateKey = createPrivateKey(options.privateKey)
  } catch {
    throw new Error('TIA artifact signing key is not a valid private key')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('TIA artifact signing key must be Ed25519')
  }
  return {
    ...unsigned,
    signature: sign(null, payload(unsigned), privateKey).toString('base64url'),
  }
}

export interface TiaArtifactTrustResult {
  keyId?: string
  reason: string
  trusted: boolean
}

export function verifyArtifactAttestation(input: {
  attestation: unknown
  graph: TiaRuntimeGraph
  graphSha256?: string
  now?: Date
  policy?: TiaArtifactTrustPolicy
  runner?: string
}): TiaArtifactTrustResult {
  const policy = input.policy ?? {}
  const attestation = parseArtifactAttestation(input.attestation)
  if (attestation === null) {
    return policy.allowUnsigned === true
      ? { reason: 'unsigned artifacts explicitly allowed', trusted: true }
      : { reason: 'artifact has no valid attestation', trusted: false }
  }

  const publicKey = policy.publicKeys?.[attestation.keyId]
  if (publicKey === undefined) {
    return {
      keyId: attestation.keyId,
      reason: `artifact key is not trusted: ${attestation.keyId}`,
      trusted: false,
    }
  }

  let key
  try {
    key = createPublicKey(publicKey)
  } catch {
    return {
      keyId: attestation.keyId,
      reason: `trusted artifact key is invalid: ${attestation.keyId}`,
      trusted: false,
    }
  }
  const { signature, ...unsigned } = attestation
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(
      null,
      payload(unsigned),
      key,
      Buffer.from(signature, 'base64url'),
    )
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact signature is invalid',
      trusted: false,
    }
  }

  const now = (input.now ?? new Date()).getTime()
  const issuedAt = timestamp(attestation.claim.issuedAt)!
  const expiresAt = timestamp(attestation.claim.expiresAt)!
  if (issuedAt > now + 5 * 60_000) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact attestation is not valid yet',
      trusted: false,
    }
  }
  if (expiresAt <= now) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact attestation has expired',
      trusted: false,
    }
  }
  if (expiresAt <= issuedAt) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact attestation has an invalid validity window',
      trusted: false,
    }
  }
  if (
    policy.maxAgeSeconds !== undefined &&
    now - issuedAt > policy.maxAgeSeconds * 1_000
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact attestation exceeds the allowed age',
      trusted: false,
    }
  }
  if (
    policy.notBefore !== undefined &&
    issuedAt < (timestamp(policy.notBefore) ?? Number.POSITIVE_INFINITY)
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact predates the trust policy',
      trusted: false,
    }
  }

  const claim = attestation.claim
  if (
    input.graphSha256 === undefined ||
    claim.graphSha256 !== input.graphSha256
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact graph digest does not match its attestation',
      trusted: false,
    }
  }
  if (
    claim.fingerprint !== input.graph.fingerprint ||
    claim.lineage.baseline.sha !== input.graph.baseline.sha ||
    claim.lineage.baseline.source !== input.graph.baseline.source
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact graph identity does not match its attestation',
      trusted: false,
    }
  }
  if (
    input.runner !== undefined &&
    claim.runner !== input.runner
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact runner does not match its attestation',
      trusted: false,
    }
  }
  if (policy.requirePromoted === true && !claim.promoted) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact is not a promoted baseline',
      trusted: false,
    }
  }
  if (
    policy.allowedProducers !== undefined &&
    (
      claim.lineage.producer === undefined ||
      !policy.allowedProducers.includes(claim.lineage.producer)
    )
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact producer is not trusted',
      trusted: false,
    }
  }
  if (
    policy.allowedBaselineSources !== undefined &&
    (
      claim.lineage.baseline.source === undefined ||
      !policy.allowedBaselineSources.includes(
        claim.lineage.baseline.source,
      )
    )
  ) {
    return {
      keyId: attestation.keyId,
      reason: 'artifact baseline source is not trusted',
      trusted: false,
    }
  }

  return {
    keyId: attestation.keyId,
    reason: 'artifact signature and trust policy verified',
    trusted: true,
  }
}
