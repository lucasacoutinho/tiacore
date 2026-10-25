import { readFileSync } from 'node:fs'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, test } from 'vitest'

import {
  TIA_ARTIFACT_ATTESTATION_VERSION,
  TIA_ARTIFACT_MANIFEST_VERSION,
  type TiaArtifactClaimV1,
} from '../../src/core/artifacts.ts'
import { readManifest } from '../../src/engine/artifacts/schema.ts'
import {
  createArtifactAttestation,
  parseArtifactAttestation,
} from '../../src/engine/artifacts/trust.ts'
import { privateKeyPem } from './support.ts'

// The committed schemas are what other SDKs and third parties validate
// against. The decoders must accept a subset of what the schemas accept, and
// reject what the schemas reject.

function committed(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../schemas/${name}`, import.meta.url), 'utf8'),
  )
}

const ajv = new Ajv2020({ allErrors: false, strict: false })
const attestationSchema = committed(
  'tiacore-artifact-attestation-v1.schema.json',
)
const manifestSchema = committed('tiacore-artifact-manifest-v1.schema.json')
const schemaAccepts = {
  attestation: ajv.compile(attestationSchema),
  manifest: ajv.compile(manifestSchema),
}

const claim: TiaArtifactClaimV1 = {
  expiresAt: '2026-08-07T20:00:00.000Z',
  fingerprint: 'structural-fingerprint',
  graphSha256: 'a'.repeat(64),
  issuedAt: '2026-07-31T20:00:00.000Z',
  lineage: {
    baseline: { sha: 'source-revision', source: 'git' },
    parents: ['previous-artifact-id', 7],
    producedAt: '2026-07-31T20:00:00.000Z',
    producer: 'ci-system-name',
    runId: 'pipeline-42',
  },
  promoted: true,
  runner: 'node',
}
const attestation = createArtifactAttestation(claim, {
  keyId: 'release-2026',
  privateKey: privateKeyPem,
})
const entry = {
  fingerprint: 'structural-fingerprint',
  group: 'pipeline-42',
  id: 'pipeline-42-shard-1',
  lineage: claim.lineage,
  promoted: true,
  runner: 'node',
  sha256: 'b'.repeat(64),
  size: 12345,
  url: 'https://storage.example/tiacore-42-1.zip',
}
const manifest = {
  artifacts: [entry],
  generatedAt: '2026-07-31T20:00:00.000Z',
  version: 1,
}

function mutate<T>(value: T, change: (copy: any) => void): unknown {
  const copy = structuredClone(value)
  change(copy)
  return copy
}

describe('attestation schema', () => {
  const documents: Record<string, unknown> = {
    'the published example': attestation,
    'integer parents': mutate(attestation, (a) => {
      a.claim.lineage.parents = [1, 2, 3]
    }),
    'no optional fields': mutate(attestation, (a) => {
      delete a.claim.runner
      delete a.claim.lineage.producer
      delete a.claim.lineage.baseline.source
    }),
    'maximum parents': mutate(attestation, (a) => {
      a.claim.lineage.parents = Array.from({ length: 100 }, (_, i) => i)
    }),
    'longest text': mutate(attestation, (a) => {
      a.claim.fingerprint = 'f'.repeat(8192)
    }),
    'extra top-level field': mutate(attestation, (a) => {
      a.extra = true
    }),
    'extra claim field': mutate(attestation, (a) => {
      a.claim.extra = true
    }),
    'extra lineage field': mutate(attestation, (a) => {
      a.claim.lineage.extra = true
    }),
    'too many parents': mutate(attestation, (a) => {
      a.claim.lineage.parents = Array.from({ length: 101 }, (_, i) => i)
    }),
    'duplicate parents': mutate(attestation, (a) => {
      a.claim.lineage.parents = ['a', 'a']
    }),
    'text over 8192': mutate(attestation, (a) => {
      a.claim.lineage.runId = 'r'.repeat(8193)
    }),
    'empty runner': mutate(attestation, (a) => {
      a.claim.runner = ''
    }),
    'unknown source': mutate(attestation, (a) => {
      a.claim.lineage.baseline.source = 'svn'
    }),
    'wrong version': mutate(attestation, (a) => {
      a.version = 2
    }),
    'uppercase digest': mutate(attestation, (a) => {
      a.claim.graphSha256 = 'A'.repeat(64)
    }),
    'short signature': mutate(attestation, (a) => {
      a.signature = 'abc'
    }),
    'key id with a space': mutate(attestation, (a) => {
      a.keyId = 'a b'
    }),
    'missing claim': mutate(attestation, (a) => {
      delete a.claim
    }),
    'fractional parent': mutate(attestation, (a) => {
      a.claim.lineage.parents = [1.5]
    }),
  }

  for (const [name, document] of Object.entries(documents)) {
    test(`the decoder and the schema agree: ${name}`, () => {
      expect(parseArtifactAttestation(document) !== null).toBe(
        schemaAccepts.attestation(document),
      )
    })
  }

  test('constants equal the schema consts', () => {
    const properties = attestationSchema['properties'] as Record<
      string,
      { const?: unknown }
    >
    expect(properties['version']?.const).toBe(TIA_ARTIFACT_ATTESTATION_VERSION)
    const manifestProperties = manifestSchema['properties'] as Record<
      string,
      { const?: unknown }
    >
    expect(manifestProperties['version']?.const).toBe(
      TIA_ARTIFACT_MANIFEST_VERSION,
    )
  })
})

describe('manifest schema', () => {
  const documents: Record<string, unknown> = {
    'the published example': manifest,
    'only id and url': { artifacts: [{ id: 1, url: 'a.zip' }], version: 1 },
    'no entries': { artifacts: [], version: 1 },
    'maximum entries': {
      artifacts: Array.from({ length: 100 }, (_, index) => ({
        id: index,
        url: 'a',
      })),
      version: 1,
    },
    'maximum size': mutate(manifest, (m) => {
      m.artifacts[0].size = 26214400
    }),
    'extra top-level field': mutate(manifest, (m) => {
      m.extra = 1
    }),
    'extra entry field': mutate(manifest, (m) => {
      m.artifacts[0].extra = 1
    }),
    'too many entries': {
      artifacts: Array.from({ length: 101 }, (_, index) => ({
        id: index,
        url: 'a',
      })),
      version: 1,
    },
    'url over 8192': mutate(manifest, (m) => {
      m.artifacts[0].url = 'u'.repeat(8193)
    }),
    'empty url': mutate(manifest, (m) => {
      m.artifacts[0].url = ''
    }),
    'size over the limit': mutate(manifest, (m) => {
      m.artifacts[0].size = 26214401
    }),
    'negative size': mutate(manifest, (m) => {
      m.artifacts[0].size = -1
    }),
    'uppercase digest': mutate(manifest, (m) => {
      m.artifacts[0].sha256 = 'B'.repeat(64)
    }),
    'fractional id': mutate(manifest, (m) => {
      m.artifacts[0].id = 1.5
    }),
    'missing id': mutate(manifest, (m) => {
      delete m.artifacts[0].id
    }),
    'wrong version': mutate(manifest, (m) => {
      m.version = 2
    }),
    'lineage missing run id': mutate(manifest, (m) => {
      delete m.artifacts[0].lineage.runId
    }),
    'lineage with 101 parents': mutate(manifest, (m) => {
      m.artifacts[0].lineage.parents = Array.from({ length: 101 }, (_, i) => i)
    }),
  }

  for (const [name, document] of Object.entries(documents)) {
    test(`the decoder and the schema agree: ${name}`, () => {
      expect(readManifest(document) !== null).toBe(
        schemaAccepts.manifest(document),
      )
    })
  }
})
