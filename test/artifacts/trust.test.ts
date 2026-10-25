import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import {
  attestationPayload,
  type TiaArtifactClaimV1,
  type TiaArtifactTrustPolicy,
} from '../../src/core/artifacts.ts'
import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import {
  createArtifactAttestation,
  parseArtifactAttestation,
  verifyArtifactAttestation,
} from '../../src/engine/artifacts/trust.ts'
import {
  cacheDirectory,
  graph as baseGraph,
  privateKeyPem as privateKey,
  publicKeyPem as publicKey,
  restore,
  sha256,
} from './support.ts'

// Port of 1.x test/unit/artifacts/trust.test.ts, plus the ART-ATT, ART-TRUST
// and SCHEMA-ATTEST rows 1.x left untested.

const secondKeys = generateKeyPairSync('ed25519')
const secondPublicKey = secondKeys.publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString()

const NOW = Date.now()
const hour = 3_600_000
const iso = (offset: number) => new Date(NOW + offset).toISOString()

function graph(): TiaRuntimeGraph {
  return baseGraph('fixture-fingerprint', {
    baseline: { sha: 'baseline-abc', source: 'git', workingTree: {} },
  })
}

const digestOf = (value: TiaRuntimeGraph): string =>
  sha256(`${JSON.stringify(value)}\n`)

function claim(
  value: TiaRuntimeGraph,
  overrides: Partial<TiaArtifactClaimV1> = {},
): TiaArtifactClaimV1 {
  return {
    expiresAt: iso(24 * hour),
    fingerprint: value.fingerprint,
    graphSha256: digestOf(value),
    issuedAt: iso(-hour),
    lineage: {
      baseline: { sha: value.baseline.sha, source: 'git' },
      parents: [],
      producedAt: iso(-hour),
      producer: 'trusted-ci',
      runId: 'run-42',
    },
    promoted: true,
    runner: 'node',
    ...overrides,
  }
}

function trust(overrides: TiaArtifactTrustPolicy = {}): TiaArtifactTrustPolicy {
  return {
    allowedBaselineSources: ['git'],
    allowedProducers: ['trusted-ci'],
    publicKeys: { 'release-2026': publicKey },
    requirePromoted: true,
    ...overrides,
  }
}

const sign = (value: TiaArtifactClaimV1, keyId = 'release-2026') =>
  createArtifactAttestation(value, { keyId, privateKey })

function verifyClaim(
  candidate: TiaArtifactClaimV1,
  policy: TiaArtifactTrustPolicy = trust(),
  value = graph(),
) {
  return verifyArtifactAttestation({
    attestation: sign(candidate),
    graph: value,
    graphSha256: digestOf(graph()),
    policy,
    runner: 'node',
  })
}

describe('artifact authenticity and trust policy', () => {
  test('restores an artifact only after verifying its signature and policy', async () => {
    const value = graph()
    const attestation = sign(claim(value))

    const result = await restore(
      {
        cacheDir: cacheDirectory(),
        fingerprint: value.fingerprint,
        log: false,
        providers: [
          {
            load: () => ({
              attestation,
              graph: value,
              graphSha256: digestOf(value),
              id: 'signed-artifact',
            }),
            name: 'portable store',
          },
        ],
        runner: 'node',
        trust: trust(),
      },
      ['baseline-abc'],
    )

    expect(result).toMatchObject({
      artifactId: 'signed-artifact',
      restored: true,
      trust: {
        keyId: 'release-2026',
        reason: 'artifact signature and trust policy verified',
      },
    })
  })

  test('rejects tampering and untrusted signing keys', () => {
    const value = graph()
    const attestation = sign(claim(value))
    const tampered = structuredClone(value)
    tampered.results['a']!.state = 'failed'

    expect(
      verifyArtifactAttestation({
        attestation,
        graph: tampered,
        graphSha256: digestOf(tampered),
        policy: trust(),
        runner: 'node',
      }),
    ).toMatchObject({
      reason: 'artifact graph digest does not match its attestation',
      trusted: false,
    })

    expect(
      verifyArtifactAttestation({
        attestation,
        graph: value,
        graphSha256: digestOf(value),
        policy: trust({ publicKeys: { 'release-2026': secondPublicKey } }),
        runner: 'node',
      }),
    ).toMatchObject({
      reason: 'artifact signature is invalid',
      trusted: false,
    })
  })

  test('rejects expired, replayed, unpromoted, and unauthorized artifacts', () => {
    const value = graph()
    expect(
      verifyClaim(claim(value, { expiresAt: iso(-30 * 60_000) })).reason,
    ).toBe('artifact attestation has expired')
    expect(verifyClaim(claim(value), trust({ maxAgeSeconds: 60 })).reason).toBe(
      'artifact attestation exceeds the allowed age',
    )
    expect(verifyClaim(claim(value, { promoted: false })).reason).toBe(
      'artifact is not a promoted baseline',
    )
    expect(
      verifyClaim(
        claim(value, {
          lineage: { ...claim(value).lineage, producer: 'untrusted-ci' },
        }),
      ).reason,
    ).toBe('artifact producer is not trusted')
  })

  test('rejects unsigned artifacts by default', async () => {
    const value = graph()
    await expect(
      restore({
        cacheDir: cacheDirectory(),
        fingerprint: value.fingerprint,
        log: false,
        providers: [
          {
            load: () => ({ graph: value, id: 'unsigned' }),
            name: 'portable store',
          },
        ],
        trust: {},
      }),
    ).resolves.toEqual({
      reason: 'no provider returned a trusted compatible artifact',
      restored: false,
    })
  })
})

describe('signing payload and keys', () => {
  const fixed: TiaArtifactClaimV1 = {
    expiresAt: '2026-08-02T00:00:00.000Z',
    fingerprint: 'fp',
    graphSha256: 'a'.repeat(64),
    issuedAt: '2026-07-31T00:00:00.000Z',
    lineage: {
      baseline: { sha: 's', source: 'git' },
      parents: ['p'],
      producedAt: '2026-07-31T00:00:00.000Z',
      runId: 'r',
    },
    promoted: true,
  }

  test('the signature covers the compact key-sorted JSON, with no pre-hash', () => {
    const attestation = createArtifactAttestation(fixed, {
      keyId: 'k',
      privateKey,
    })
    const literal =
      '{"algorithm":"Ed25519","claim":{"expiresAt":"2026-08-02T00:00:00.000Z",' +
      '"fingerprint":"fp","graphSha256":"' +
      'a'.repeat(64) +
      '","issuedAt":"2026-07-31T00:00:00.000Z","lineage":{"baseline":' +
      '{"sha":"s","source":"git"},"parents":["p"],"producedAt":' +
      '"2026-07-31T00:00:00.000Z","runId":"r"},"promoted":true},"keyId":"k","version":1}'
    const { signature, ...unsigned } = attestation
    expect(attestationPayload(unsigned)).toBe(literal)
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u)
    expect(
      verify(
        null,
        Buffer.from(literal),
        createPublicKey(publicKey),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
  })

  test('keys sort by UTF-16 code unit, arrays keep their order', () => {
    expect(
      attestationPayload({
        algorithm: 'Ed25519',
        claim: { z: 1, a: [3, { b: 1, a: 2 }], '\u{1F600}': 0, '～': 0 },
        keyId: 'k',
        version: 1,
      } as never),
    ).toBe(
      '{"algorithm":"Ed25519","claim":{"a":[3,{"a":2,"b":1}],"z":1,"\u{1F600}":0,"～":0},"keyId":"k","version":1}',
    )
  })

  test('accepts PEM, PEM with literal \\n, and base64 DER keys', () => {
    const pem = privateKey
    const flat = pem.trim().replaceAll('\n', '\\n')
    const der = pem.replace(/-----[A-Z ]+-----|\s/gu, '')
    const publicDer = publicKey.replace(/-----[A-Z ]+-----|\s/gu, '')
    const signatures = [pem, flat, der, `  ${der}\n`].map(
      (text) =>
        createArtifactAttestation(fixed, { keyId: 'k', privateKey: text })
          .signature,
    )
    expect(new Set(signatures).size).toBe(1)
    for (const key of [
      publicKey,
      publicKey.trim().replaceAll('\n', '\\n'),
      publicDer,
    ]) {
      expect(
        verifyArtifactAttestation({
          attestation: sign(claim(graph())),
          graph: graph(),
          graphSha256: digestOf(graph()),
          policy: trust({ publicKeys: { 'release-2026': key } }),
          runner: 'node',
        }).trusted,
      ).toBe(true)
    }
  })

  test('rejects bad key ids and keys with fixed messages', () => {
    expect(() =>
      createArtifactAttestation(fixed, { keyId: 'bad key', privateKey }),
    ).toThrow('TIA artifact signing key id is invalid')
    expect(() =>
      createArtifactAttestation(fixed, { keyId: 'k', privateKey: 'nope' }),
    ).toThrow('TIA artifact signing key is not a valid private key')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() =>
      createArtifactAttestation(fixed, {
        keyId: 'k',
        privateKey: rsa.privateKey
          .export({ format: 'pem', type: 'pkcs8' })
          .toString(),
      }),
    ).toThrow('TIA artifact signing key must be Ed25519')
    try {
      createArtifactAttestation(fixed, {
        keyId: 'k',
        privateKey: 'secret-material',
      })
    } catch (error) {
      expect(String(error)).not.toContain('secret-material')
    }
  })
})

describe('attestation documents', () => {
  const value = graph()
  const good = () => sign(claim(value))

  test('parse copies a well-formed document and rejects anything the schema rejects', () => {
    const attestation = good()
    expect(parseArtifactAttestation(attestation)).toEqual(attestation)
    expect(parseArtifactAttestation(attestation)).not.toBe(attestation)
    const long = 'x'.repeat(8_193)
    const bad: unknown[] = [
      null,
      { ...attestation, extra: 1 },
      { ...attestation, claim: { ...attestation.claim, extra: 1 } },
      { ...attestation, version: 2 },
      { ...attestation, keyId: 'a b' },
      { ...attestation, signature: 'short' },
      {
        ...attestation,
        claim: { ...attestation.claim, fingerprint: long },
      },
      {
        ...attestation,
        claim: {
          ...attestation.claim,
          lineage: {
            ...attestation.claim.lineage,
            parents: Array.from({ length: 101 }, (_, index) => index),
          },
        },
      },
      {
        ...attestation,
        claim: {
          ...attestation.claim,
          lineage: { ...attestation.claim.lineage, parents: ['a', 'a'] },
        },
      },
      {
        ...attestation,
        claim: { ...attestation.claim, graphSha256: 'A'.repeat(64) },
      },
      { ...attestation, claim: { ...attestation.claim, issuedAt: 'never' } },
    ]
    for (const item of bad) expect(parseArtifactAttestation(item)).toBeNull()
  })

  test('an attestation with 100 parents and 8192-character text is valid', () => {
    const wide = claim(value, {
      fingerprint: 'f'.repeat(8_192),
      lineage: {
        ...claim(value).lineage,
        parents: Array.from({ length: 100 }, (_, index) => index),
      },
    })
    expect(parseArtifactAttestation(sign(wide))).not.toBeNull()
  })
})

describe('verification order and verdicts', () => {
  const value = graph()

  test('a malformed attestation is unsigned: allowUnsigned accepts only that', () => {
    const unsigned = verifyArtifactAttestation({
      attestation: { version: 1 },
      graph: value,
      policy: { allowUnsigned: true },
    })
    expect(unsigned).toEqual({
      reason: 'unsigned artifacts explicitly allowed',
      trusted: true,
    })
    expect(
      verifyArtifactAttestation({ attestation: undefined, graph: value })
        .reason,
    ).toBe('artifact has no valid attestation')
  })

  test('allowUnsigned never downgrades a well-formed signed attestation', () => {
    const result = verifyArtifactAttestation({
      attestation: sign(claim(value)),
      graph: value,
      graphSha256: digestOf(value),
      policy: { allowUnsigned: true },
    })
    expect(result).toMatchObject({
      reason: 'artifact key is not trusted: release-2026',
      trusted: false,
    })
  })

  test('reports an unparseable trusted key', () => {
    expect(
      verifyClaim(claim(value), trust({ publicKeys: { 'release-2026': 'x' } }))
        .reason,
    ).toBe('trusted artifact key is invalid: release-2026')
  })

  test('accepts an issue time inside the five minute skew and rejects beyond it', () => {
    expect(
      verifyClaim(claim(value, { issuedAt: iso(4 * 60_000) })).trusted,
    ).toBe(true)
    expect(
      verifyClaim(claim(value, { issuedAt: iso(6 * 60_000) })).reason,
    ).toBe('artifact attestation is not valid yet')
  })

  test('rejects a validity window that ends before it starts', () => {
    expect(
      verifyClaim(
        claim(value, { expiresAt: iso(2 * 60_000), issuedAt: iso(4 * 60_000) }),
      ).reason,
    ).toBe('artifact attestation has an invalid validity window')
  })

  test('notBefore rejects older issuances; an unparseable value rejects all', () => {
    expect(verifyClaim(claim(value), trust({ notBefore: iso(0) })).reason).toBe(
      'artifact predates the trust policy',
    )
    expect(
      verifyClaim(claim(value), trust({ notBefore: iso(-2 * hour) })).trusted,
    ).toBe(true)
    expect(
      verifyClaim(claim(value), trust({ notBefore: 'garbage' })).reason,
    ).toBe('artifact predates the trust policy')
  })

  test('checks the graph identity, runner and baseline source', () => {
    expect(verifyClaim(claim(value, { fingerprint: 'other' })).reason).toBe(
      'artifact graph identity does not match its attestation',
    )
    expect(
      verifyArtifactAttestation({
        attestation: sign(claim(value)),
        graph: { ...value, baseline: { ...value.baseline, sha: 'moved' } },
        graphSha256: digestOf(value),
        policy: trust(),
      }).reason,
    ).toBe('artifact graph identity does not match its attestation')
    expect(
      verifyArtifactAttestation({
        attestation: sign(claim(value)),
        graph: value,
        graphSha256: digestOf(value),
        policy: trust(),
        runner: 'bun',
      }).reason,
    ).toBe('artifact runner does not match its attestation')
    expect(
      verifyArtifactAttestation({
        attestation: sign(claim(value)),
        graph: value,
        graphSha256: digestOf(value),
        policy: trust(),
      }).trusted,
    ).toBe(true)
    expect(
      verifyClaim(
        claim(value),
        trust({ allowedBaselineSources: ['filesystem'] }),
      ).reason,
    ).toBe('artifact baseline source is not trusted')
    expect(
      verifyArtifactAttestation({
        attestation: sign(claim(value)),
        graph: value,
      }).reason,
    ).toBe('artifact key is not trusted: release-2026')
    expect(
      verifyArtifactAttestation({
        attestation: sign(claim(value)),
        graph: value,
        policy: trust(),
      }).reason,
    ).toBe('artifact graph digest does not match its attestation')
  })

  test('the first failing check decides, in the order the spec lists', () => {
    // Everything wrong at once, then fixed from the top of the list down.
    const broken = claim(value, {
      expiresAt: iso(-hour),
      fingerprint: 'other',
      graphSha256: 'b'.repeat(64),
      promoted: false,
      runner: 'bun',
    })
    const run = (policy: TiaArtifactTrustPolicy, attestation = sign(broken)) =>
      verifyArtifactAttestation({
        attestation,
        graph: value,
        graphSha256: digestOf(value),
        policy,
        runner: 'node',
      }).reason
    const strictPolicy = trust({
      allowedProducers: ['someone-else'],
      maxAgeSeconds: 1,
      requirePromoted: true,
    })
    expect(
      run(
        strictPolicy,
        createArtifactAttestation(broken, { keyId: 'unknown', privateKey }),
      ),
    ).toBe('artifact key is not trusted: unknown')
    expect(
      run({ ...strictPolicy, publicKeys: { 'release-2026': secondPublicKey } }),
    ).toBe('artifact signature is invalid')
    expect(run(strictPolicy)).toBe(
      'artifact graph digest does not match its attestation',
    )
    const digestOk = { ...broken, graphSha256: digestOf(value) }
    expect(run(strictPolicy, sign(digestOk))).toBe(
      'artifact graph identity does not match its attestation',
    )
    const identityOk = { ...digestOk, fingerprint: value.fingerprint }
    expect(run(strictPolicy, sign(identityOk))).toBe(
      'artifact runner does not match its attestation',
    )
    const runnerOk = { ...identityOk, runner: 'node' }
    // The validity window is checked before any policy rule.
    expect(run(strictPolicy, sign(runnerOk))).toBe(
      'artifact attestation has expired',
    )
    const windowOk = { ...runnerOk, expiresAt: iso(hour) }
    expect(run(strictPolicy, sign(windowOk))).toBe(
      'artifact attestation exceeds the allowed age',
    )
    const { maxAgeSeconds: _age, ...ageIgnored } = strictPolicy
    expect(run(ageIgnored, sign(windowOk))).toBe(
      'artifact is not a promoted baseline',
    )
    expect(run(ageIgnored, sign({ ...windowOk, promoted: true }))).toBe(
      'artifact producer is not trusted',
    )
  })
})
