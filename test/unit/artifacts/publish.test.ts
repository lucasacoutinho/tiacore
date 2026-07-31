import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  archiveGraph,
  readArtifactArchive,
} from '../../../src/engine/artifacts/archive.js'
import { tia } from '../../../src/engine/artifacts/publish.js'
import { emptyGraph } from '../../../src/engine/state/update.js'
import { writeGraph } from '../../../src/engine/state/store.js'
import type { TiaArtifactManifestV1 } from '../../../src/engine/artifacts/types.js'

const signingKeys = generateKeyPairSync('ed25519')
const signing = {
  keyId: 'fixture-key',
  privateKey: signingKeys.privateKey
    .export({
      format: 'pem',
      type: 'pkcs8',
    })
    .toString(),
}

const temporaryDirectories: string[] = []

function project(): { cacheDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-publish-'))
  temporaryDirectories.push(root)
  const cacheDir = join(root, '.tia/node')
  const graph = emptyGraph()
  graph.baseline = {
    sha: 'baseline-abc',
    source: 'git',
    workingTree: {},
  }
  graph.complete = true
  graph.coverageComplete = true
  graph.fingerprint = 'node-22-linux'
  graph.updatedAt = new Date(0).toISOString()
  writeGraph(cacheDir, graph)
  return { cacheDir, root }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('provider-neutral artifact publishing', () => {
  test('writes a restorable archive and a promoted lineage manifest', async () => {
    const { root } = project()
    const receipt = await tia({
      artifactId: 'build-42',
      cacheDir: '.tia/node',
      filesystem: { baseUrl: 'https://artifacts.example/tia' },
      parents: ['build-41'],
      producer: 'fixture-ci',
      requireCoverage: true,
      root,
      runId: 'pipeline-42',
      runner: 'node',
      signing,
    }).promote()

    expect(receipt).toMatchObject({
      artifactId: 'build-42',
      baselineSha: 'baseline-abc',
      keyId: 'fixture-key',
      promoted: true,
      sink: 'filesystem artifact sink',
    })
    expect(receipt.artifactUrl).toMatch(
      /^https:\/\/artifacts\.example\/tia\/tiacore-[a-f0-9]+\.zip$/,
    )
    const output = join(root, '.tia-artifacts')
    const archiveName = readdirSync(output).find((file) =>
      file.endsWith('.zip'),
    )!
    const archive = new Uint8Array(readFileSync(join(output, archiveName)))
    expect(archiveGraph(archive, 'node')).toMatchObject({
      fingerprint: 'node-22-linux',
    })
    expect(readArtifactArchive(archive, 'node')?.attestation).toMatchObject({
      algorithm: 'Ed25519',
      claim: {
        fingerprint: 'node-22-linux',
        promoted: true,
        runner: 'node',
      },
      keyId: 'fixture-key',
      version: 1,
    })

    const manifest = JSON.parse(
      readFileSync(join(output, 'manifest.json'), 'utf8'),
    ) as TiaArtifactManifestV1
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({
        fingerprint: 'node-22-linux',
        id: 'build-42',
        lineage: expect.objectContaining({
          baseline: { sha: 'baseline-abc', source: 'git' },
          parents: ['build-41'],
          producer: 'fixture-ci',
          runId: 'pipeline-42',
        }),
        promoted: true,
        runner: 'node',
        sha256: receipt.sha256,
        size: receipt.bytes,
      }),
    ])
  })

  test('refuses to promote partial or coverage-incomplete graphs', async () => {
    const { cacheDir, root } = project()
    const graph = emptyGraph()
    graph.baseline = { sha: 'abc', workingTree: {} }
    graph.fingerprint = 'fixture'
    graph.partition = { index: 1, total: 2 }
    writeGraph(cacheDir, graph)

    await expect(
      tia({
        artifactId: 'partial',
        cacheDir: '.tia/node',
        root,
        runId: 'run',
        signing,
      }).publish(),
    ).resolves.toMatchObject({ promoted: false })

    await expect(
      tia({
        artifactId: 'partial',
        cacheDir: '.tia/node',
        root,
        runId: 'run',
        signing,
      }).promote(),
    ).rejects.toThrow('refuses to promote a partial graph')

    graph.complete = true
    delete graph.partition
    writeGraph(cacheDir, graph)
    await expect(
      tia({
        artifactId: 'no-coverage',
        cacheDir: '.tia/node',
        requireCoverage: true,
        root,
        runId: 'run',
        signing,
      }).promote(),
    ).rejects.toThrow('without complete coverage')
  })

  test('supports a custom sink without provider-specific publishing code', async () => {
    const { root } = project()
    const keys: string[] = []
    const sink = {
      name: 'fixture object store',
      put(input: { key: string }) {
        keys.push(input.key)
        return { url: `object://${input.key}` }
      },
    }
    const receipt = await tia({
      artifactId: 'custom',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      sink,
      signing,
    }).publish()

    expect(keys).toEqual([
      expect.stringMatching(/^tiacore-[a-f0-9]+\.zip$/),
      'manifest.json',
    ])
    expect(receipt).toMatchObject({
      artifactUrl: expect.stringMatching(/^object:\/\/tiacore-/),
      manifestUrl: 'object://manifest.json',
      sink: 'fixture object store',
    })
  })
})
