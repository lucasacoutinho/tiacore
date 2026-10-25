import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { restoreGraphFromArtifacts } from '../../../src/engine/artifacts/restore.js'
import {
  createArtifactAttestation,
  verifyArtifactAttestation,
} from '../../../src/engine/artifacts/trust.js'
import type {
  TiaArtifactClaimV1,
  TiaArtifactTrustPolicy,
  TiaRuntimeGraph,
} from '../../../src/shared/types.js'

const keys = generateKeyPairSync('ed25519')
const secondKeys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey
  .export({
    format: 'pem',
    type: 'pkcs8',
  })
  .toString()
const publicKey = keys.publicKey
  .export({
    format: 'pem',
    type: 'spki',
  })
  .toString()
const secondPublicKey = secondKeys.publicKey
  .export({
    format: 'pem',
    type: 'spki',
  })
  .toString()
const temporaryDirectories: string[] = []

function graph(): TiaRuntimeGraph {
  return {
    baseline: { sha: 'baseline-abc', source: 'git', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: true,
    coverageMaps: {},
    edges: { 'test/a.test.ts': ['src/a.ts', 'test/a.test.ts'] },
    fingerprint: 'fixture-fingerprint',
    results: {
      a: {
        file: 'test/a.test.ts',
        fullName: 'a',
        id: 'a',
        state: 'passed',
      },
    },
    schema: 4,
    testCoverage: {},
    testEdges: {
      a: {
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
      },
    },
    updatedAt: new Date(0).toISOString(),
  }
}

function graphDigest(value: TiaRuntimeGraph): string {
  return createHash('sha256')
    .update(`${JSON.stringify(value)}\n`)
    .digest('hex')
}

function claim(
  value: TiaRuntimeGraph,
  overrides: Partial<TiaArtifactClaimV1> = {},
): TiaArtifactClaimV1 {
  return {
    expiresAt: '2026-08-02T00:00:00.000Z',
    fingerprint: value.fingerprint,
    graphSha256: graphDigest(value),
    issuedAt: '2026-07-31T00:00:00.000Z',
    lineage: {
      baseline: { sha: value.baseline.sha, source: 'git' },
      parents: [],
      producedAt: '2026-07-31T00:00:00.000Z',
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

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('artifact authenticity and trust policy', () => {
  test('restores an artifact only after verifying its signature and policy', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'))
    const value = graph()
    const attestation = createArtifactAttestation(claim(value), {
      keyId: 'release-2026',
      privateKey,
    })
    const cacheDir = mkdtempSync(join(tmpdir(), 'tiacore-trust-'))
    temporaryDirectories.push(cacheDir)

    const result = await restoreGraphFromArtifacts({
      cacheDir,
      fingerprint: value.fingerprint,
      log: false,
      providers: [
        {
          load: () => ({
            attestation,
            graph: value,
            graphSha256: graphDigest(value),
            id: 'signed-artifact',
          }),
          name: 'portable store',
        },
      ],
      runner: 'node',
      trust: trust(),
    })

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
    const attestation = createArtifactAttestation(claim(value), {
      keyId: 'release-2026',
      privateKey,
    })
    const tampered = structuredClone(value)
    tampered.results.a!.state = 'failed'

    expect(
      verifyArtifactAttestation({
        attestation,
        graph: tampered,
        graphSha256: graphDigest(tampered),
        now: new Date('2026-07-31T12:00:00.000Z'),
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
        graphSha256: graphDigest(value),
        now: new Date('2026-07-31T12:00:00.000Z'),
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
    const verifyClaim = (
      candidate: TiaArtifactClaimV1,
      policy: TiaArtifactTrustPolicy,
    ) =>
      verifyArtifactAttestation({
        attestation: createArtifactAttestation(candidate, {
          keyId: 'release-2026',
          privateKey,
        }),
        graph: value,
        graphSha256: graphDigest(value),
        now: new Date('2026-07-31T12:00:00.000Z'),
        policy,
        runner: 'node',
      })

    expect(
      verifyClaim(
        claim(value, { expiresAt: '2026-07-31T11:00:00.000Z' }),
        trust(),
      ).reason,
    ).toBe('artifact attestation has expired')
    expect(verifyClaim(claim(value), trust({ maxAgeSeconds: 60 })).reason).toBe(
      'artifact attestation exceeds the allowed age',
    )
    expect(verifyClaim(claim(value, { promoted: false }), trust()).reason).toBe(
      'artifact is not a promoted baseline',
    )
    expect(
      verifyClaim(
        claim(value, {
          lineage: {
            ...claim(value).lineage,
            producer: 'untrusted-ci',
          },
        }),
        trust(),
      ).reason,
    ).toBe('artifact producer is not trusted')
  })

  test('rejects unsigned artifacts by default', async () => {
    const value = graph()
    const cacheDir = mkdtempSync(join(tmpdir(), 'tiacore-trust-'))
    temporaryDirectories.push(cacheDir)

    await expect(
      restoreGraphFromArtifacts({
        cacheDir,
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
