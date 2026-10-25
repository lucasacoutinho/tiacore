import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import type {
  TiaArtifactClaimV1,
  TiaArtifactPublisherOptions,
} from '../../src/core/artifacts.ts'
import { GRAPH_SCHEMA_VERSION } from '../../src/core/runtime.ts'
import { readArtifactArchive } from '../../src/engine/artifacts/archive.ts'
import { portableGraphBytes } from '../../src/engine/artifacts/portable-graph.ts'
import {
  createArtifactAttestation,
  verifyArtifactAttestation,
} from '../../src/engine/artifacts/trust.ts'
import { coverageGraph } from '../engine/support/graphs.ts'
import { legacy } from '../support/legacy.ts'
import { privateKeyPem, publicKeyPem, temporaryRoot } from './support.ts'

// 1.x and 2.0 must exchange artifacts: what one publishes the other reads,
// signs and verifies.

const trustLegacy = await legacy<{
  createArtifactAttestation: typeof createArtifactAttestation
  verifyArtifactAttestation: (input: {
    attestation: unknown
    graph: unknown
    graphSha256?: string
    now?: Date
    policy?: object
  }) => { reason: string; trusted: boolean }
}>('engine/artifacts/trust.js')
const portableLegacy = await legacy<{
  portableGraphBytes: (graph: unknown, limit: number) => Buffer
}>('engine/artifacts/portable-graph.js')
const publishLegacy = await legacy<{
  tia: (options: TiaArtifactPublisherOptions) => {
    publish: () => Promise<{ sha256: string }>
  }
}>('engine/artifacts/publish.js')
const storeLegacy = await legacy<{
  writeGraph: (cacheDir: string, graph: unknown) => void
}>('engine/state/store.js')

const claim: TiaArtifactClaimV1 = {
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  fingerprint: 'fp',
  graphSha256: 'c'.repeat(64),
  issuedAt: new Date(Date.now() - 60_000).toISOString(),
  lineage: {
    baseline: { sha: 'sha', source: 'git' },
    parents: ['p', 3],
    producedAt: new Date(Date.now() - 60_000).toISOString(),
    producer: 'ci',
    runId: 'run',
  },
  promoted: true,
  runner: 'node',
}

describe('1.x interchange', () => {
  test('the portable graph bytes are identical', () => {
    const graph = coverageGraph(25)
    expect(
      portableGraphBytes(graph, 1 << 26).equals(
        portableLegacy.portableGraphBytes(graph, 1 << 26),
      ),
    ).toBe(true)
  })

  test('both versions produce the same signature for the same claim and key', () => {
    const options = { keyId: 'k', privateKey: privateKeyPem }
    expect(createArtifactAttestation(claim, options)).toEqual(
      trustLegacy.createArtifactAttestation(claim, options),
    )
  })

  test('each version verifies the other version signature', () => {
    const graph = {
      ...coverageGraph(1),
      baseline: { sha: 'sha', source: 'git' as const, workingTree: {} },
      fingerprint: 'fp',
    }
    const bound = { ...claim, graphSha256: 'd'.repeat(64) }
    const policy = { publicKeys: { k: publicKeyPem } }
    const input = { graph, graphSha256: 'd'.repeat(64), policy, runner: 'node' }
    const fromLegacy = trustLegacy.createArtifactAttestation(bound, {
      keyId: 'k',
      privateKey: privateKeyPem,
    })
    const fromCurrent = createArtifactAttestation(bound, {
      keyId: 'k',
      privateKey: privateKeyPem,
    })
    expect(
      verifyArtifactAttestation({ ...input, attestation: fromLegacy }),
    ).toMatchObject({ trusted: true })
    expect(
      trustLegacy.verifyArtifactAttestation({
        ...input,
        attestation: fromCurrent,
      }),
    ).toMatchObject({ trusted: true })
  })

  test('reads and verifies an archive a 1.x publisher wrote', async () => {
    const root = temporaryRoot('tiacore-differential-')
    const graph = {
      ...coverageGraph(5),
      baseline: { sha: 'old-sha', source: 'git' as const, workingTree: {} },
      complete: true,
      coverageComplete: true,
      schema: 4,
    }
    storeLegacy.writeGraph(join(root, '.tia'), graph)
    await publishLegacy
      .tia({
        artifactId: 'legacy',
        root,
        runId: 'r',
        runner: 'node',
        signing: { keyId: 'k', privateKey: privateKeyPem },
      })
      .publish()
    const output = join(root, '.tia-artifacts')
    const name = readdirSync(output).find((file) => file.endsWith('.zip'))!
    const read = readArtifactArchive(
      new Uint8Array(readFileSync(join(output, name))),
      'node',
    )
    // The fixture's coverage map ids are placeholders; restoring re-derives
    // them from the map content, so compare everything else.
    const { collectionCoverage, coverageMaps, testCoverage, ...rest } = graph
    expect(read?.graph).toMatchObject({ ...rest, schema: GRAPH_SCHEMA_VERSION })
    expect(Object.keys(read?.graph.testCoverage ?? {})).toEqual(
      Object.keys(testCoverage),
    )
    expect(Object.keys(read?.graph.coverageMaps ?? {})).toHaveLength(1)
    expect(collectionCoverage).toEqual({})
    expect(Object.keys(coverageMaps)).toHaveLength(2)
    expect(
      verifyArtifactAttestation({
        attestation: read?.attestation,
        graph: read!.graph,
        graphSha256: read!.graphSha256,
        policy: { publicKeys: { k: publicKeyPem } },
        runner: 'node',
      }),
    ).toMatchObject({ trusted: true })
  })
})
