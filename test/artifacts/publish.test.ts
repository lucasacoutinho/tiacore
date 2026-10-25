import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type {
  TiaArtifactManifestV1,
  TiaArtifactSink,
} from '../../src/core/artifacts.ts'
import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import {
  archiveGraph,
  readArtifactArchive,
  writeArtifactArchive,
} from '../../src/engine/artifacts/archive.ts'
import {
  createFilesystemArtifactSink,
  tia,
} from '../../src/engine/artifacts/publisher.ts'
import { verifyArtifactAttestation } from '../../src/engine/artifacts/trust.ts'
import {
  graph as baseGraph,
  privateKeyPem,
  publicKeyPem,
  sha256,
  temporaryRoot,
  writeStored,
} from './support.ts'

// Port of 1.x test/unit/artifacts/publish.test.ts plus the ART-PUB, ART-SINK
// and ART-ZIP-writer rows 1.x left untested.

const signing = { keyId: 'fixture-key', privateKey: privateKeyPem }

function fixture(overrides: Partial<TiaRuntimeGraph> = {}) {
  const root = temporaryRoot('tiacore-publish-')
  const cacheDir = join(root, '.tia/node')
  const graph = baseGraph('node-22-linux', {
    baseline: { sha: 'baseline-abc', source: 'git', workingTree: {} },
    ...overrides,
  })
  return { cacheDir, graph, root }
}

async function project(overrides: Partial<TiaRuntimeGraph> = {}) {
  const value = fixture(overrides)
  await writeStored(value.cacheDir, value.graph)
  return value
}

afterEach(() => {
  vi.useRealTimers()
})

describe('provider-neutral artifact publishing', () => {
  test('writes a restorable archive and a promoted lineage manifest', async () => {
    const { root } = await project()
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
      /^https:\/\/artifacts\.example\/tia\/tiacore-[a-f0-9]+\.zip$/u,
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
    expect(sha256(archive)).toBe(receipt.sha256)
    expect(archiveName).toBe(`tiacore-${receipt.sha256.slice(0, 24)}.zip`)
  })

  test('refuses to promote partial or coverage-incomplete graphs', async () => {
    const { cacheDir, graph, root } = await project()
    const partial: TiaRuntimeGraph = {
      ...graph,
      complete: false,
      partition: { index: 1, total: 2 },
    }
    await writeStored(cacheDir, partial)
    const options = {
      artifactId: 'partial',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      signing,
    }

    await expect(tia(options).publish()).resolves.toMatchObject({
      promoted: false,
    })
    await expect(tia(options).promote()).rejects.toThrow(
      'refuses to promote a partial graph',
    )

    await writeStored(cacheDir, { ...graph, coverageComplete: false })
    await expect(
      tia({ ...options, requireCoverage: true }).promote(),
    ).rejects.toThrow('without complete coverage')
    await expect(tia(options).promote()).resolves.toMatchObject({
      promoted: true,
    })
  })

  test('supports a custom sink without provider-specific publishing code', async () => {
    const { root } = await project()
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
      signing,
      sink,
    }).publish()

    expect(keys).toEqual([
      expect.stringMatching(/^tiacore-[a-f0-9]+\.zip$/u),
      'manifest.json',
    ])
    expect(receipt).toMatchObject({
      artifactUrl: expect.stringMatching(/^object:\/\/tiacore-/u),
      manifestUrl: 'object://manifest.json',
      sink: 'fixture object store',
    })
  })

  test('a sink that fails or throws surfaces its own message', async () => {
    const { root } = await project()
    const options = {
      artifactId: 'x',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      signing,
    }
    const failing: TiaArtifactSink = {
      name: 'failing',
      put: () => Promise.reject(new Error('storage is down')),
    }
    const throwing: TiaArtifactSink = {
      name: 'throwing',
      put: () => {
        throw new Error('storage exploded')
      },
    }
    await expect(tia({ ...options, sink: failing }).publish()).rejects.toThrow(
      'storage is down',
    )
    await expect(tia({ ...options, sink: throwing }).publish()).rejects.toThrow(
      'storage exploded',
    )
  })

  test('a sink id replaces the configured artifact id', async () => {
    const { root } = await project()
    const receipt = await tia({
      artifactId: 'configured',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      signing,
      sink: {
        name: 's',
        put: (input) => ({
          id: input.key === 'manifest.json' ? 'ignored' : 77,
          url: `s://${input.key}`,
        }),
      },
    }).publish()
    expect(receipt.artifactId).toBe(77)
  })

  test('refuses an archive id or url the manifest schema cannot hold', async () => {
    const { root } = await project()
    await expect(
      tia({
        artifactId: 'x',
        cacheDir: '.tia/node',
        root,
        runId: 'run',
        signing,
        sink: { name: 's', put: () => ({ id: 1.5, url: 'u' }) },
      }).publish(),
    ).rejects.toThrow('TIA artifact sink returned an invalid id or url')
  })

  test('a second publish replaces the manifest but keeps the earlier archive', async () => {
    const { cacheDir, graph, root } = await project()
    const options = {
      artifactId: 'one',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      signing,
    }
    const first = await tia(options).publish()
    await writeStored(cacheDir, { ...graph, fingerprint: 'changed' })
    const second = await tia({ ...options, artifactId: 'two' }).publish()
    const output = join(root, '.tia-artifacts')
    expect(
      readdirSync(output).filter((name) => name.endsWith('.zip')),
    ).toHaveLength(2)
    const manifest = JSON.parse(
      readFileSync(join(output, 'manifest.json'), 'utf8'),
    ) as TiaArtifactManifestV1
    expect(manifest.artifacts.map((entry) => entry.id)).toEqual(['two'])
    expect(first.sha256).not.toBe(second.sha256)
  })

  test('reports each refusal with its message', async () => {
    const { graph, cacheDir, root } = await project()
    const options = {
      artifactId: 'x',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      signing,
    }
    await writeStored(cacheDir, { ...graph, complete: false })
    await expect(tia(options).publish()).rejects.toThrow(
      'TIA refuses to publish an incomplete non-partition graph',
    )
    await writeStored(cacheDir, {
      ...graph,
      baseline: { sha: '', source: 'filesystem', workingTree: {} },
    })
    await expect(tia(options).publish()).rejects.toThrow(
      'TIA refuses to publish a graph without baseline lineage',
    )
    await expect(
      tia({ ...options, cacheDir: 'missing' }).publish(),
    ).rejects.toThrow(`no valid TIA graph exists in ${join(root, 'missing')}`)
  })

  test('validates the options a publisher is built from', () => {
    const base = { artifactId: 'x', runId: 'run', signing }
    expect(() => tia({ ...base, artifactId: ' ' })).toThrow(
      'TIA artifact id cannot be empty',
    )
    expect(() => tia({ ...base, artifactId: 1.5 })).toThrow(
      'TIA artifact id must be a safe integer',
    )
    expect(() => tia({ ...base, runId: ' ' })).toThrow(
      'TIA artifact run id cannot be empty',
    )
    for (const runner of ['', '../x', 'a..b', 'a\\b', '/abs', 'C:x']) {
      expect(() => tia({ ...base, runner })).toThrow(
        'TIA artifact runner must be a safe relative path',
      )
    }
    expect(() => tia({ ...base, runner: 'a/b' })).not.toThrow()
    for (const expiresInSeconds of [0, -1, 1.5, 31_536_001, Number.NaN]) {
      expect(() =>
        tia({ ...base, signing: { ...signing, expiresInSeconds } }),
      ).toThrow(
        'TIA artifact signing expiry must be between 1 second and 1 year',
      )
    }
    expect(() =>
      tia({
        ...base,
        parents: Array.from({ length: 101 }, (_, index) => index),
      }),
    ).toThrow('more than 100 parents')
    expect(() => tia({ ...base, group: 1.5 })).toThrow('group and parent ids')
  })

  test('de-duplicates parents and signs the claim the manifest repeats', async () => {
    const { root } = await project()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'))
    const receipt = await tia({
      artifactId: 7,
      cacheDir: '.tia/node',
      group: 'g',
      parents: ['a', 'b', 'a', 3, 3],
      root,
      runId: 'run',
      signing: { ...signing, expiresInSeconds: 60 },
    }).publish()
    expect(receipt.trustExpiresAt).toBe('2026-07-31T12:01:00.000Z')
    const output = join(root, '.tia-artifacts')
    const archiveName = readdirSync(output).find((name) =>
      name.endsWith('.zip'),
    )!
    const archive = readArtifactArchive(
      new Uint8Array(readFileSync(join(output, archiveName))),
      undefined,
    )!
    expect(archive.attestation?.claim.lineage.parents).toEqual(['a', 'b', 3])
    expect(archive.attestation?.claim.issuedAt).toBe('2026-07-31T12:00:00.000Z')
    expect(archive.attestation?.claim.graphSha256).toBe(archive.graphSha256)
    expect(
      verifyArtifactAttestation({
        attestation: archive.attestation,
        graph: archive.graph,
        graphSha256: archive.graphSha256,
        now: new Date('2026-07-31T12:00:30.000Z'),
        policy: { publicKeys: { 'fixture-key': publicKeyPem } },
      }),
    ).toMatchObject({ trusted: true })
    const manifest = JSON.parse(
      readFileSync(join(output, 'manifest.json'), 'utf8'),
    ) as TiaArtifactManifestV1
    expect(manifest.generatedAt).toBe('2026-07-31T12:00:00.000Z')
    expect(manifest.artifacts[0]).toMatchObject({ group: 'g', id: 7 })
  })

  test('puts the runner namespace beside the root entries, with identical bytes', async () => {
    const { root } = await project()
    await tia({
      artifactId: 'x',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      runner: 'node',
      signing,
    }).publish()
    const output = join(root, '.tia-artifacts')
    const archiveName = readdirSync(output).find((name) =>
      name.endsWith('.zip'),
    )!
    const { unzipSync } = await import('fflate')
    const entries = unzipSync(
      new Uint8Array(readFileSync(join(output, archiveName))),
    )
    expect(Object.keys(entries)).toEqual([
      'attestation.json',
      'graph.json',
      'node/attestation.json',
      'node/graph.json',
    ])
    expect(entries['node/graph.json']).toEqual(entries['graph.json'])
    expect(entries['node/attestation.json']).toEqual(
      entries['attestation.json'],
    )
    expect(
      new TextDecoder().decode(entries['attestation.json']).endsWith('}\n'),
    ).toBe(true)
  })
})

describe('deterministic archives', () => {
  test('equal inputs under a fixed clock give the same bytes, digest and name', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'))
    const receipts = []
    for (let run = 0; run < 2; run += 1) {
      const { root } = await project()
      receipts.push(
        await tia({
          artifactId: 'x',
          cacheDir: '.tia/node',
          root,
          runId: 'run',
          runner: 'node',
          signing,
        }).publish(),
      )
    }
    expect(receipts[0]?.sha256).toBe(receipts[1]?.sha256)
    expect(receipts[0]?.artifactUrl).toBe(receipts[1]?.artifactUrl)
  })

  test('the archive does not depend on the time zone or the wall clock', () => {
    const entries: Array<[string, Uint8Array]> = [
      ['graph.json', new TextEncoder().encode('{"a":1}\n')],
      ['attestation.json', new TextEncoder().encode('{}\n')],
    ]
    const original = process.env['TZ']
    try {
      const digests = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'].map(
        (zone) => {
          process.env['TZ'] = zone
          return sha256(writeArtifactArchive(entries))
        },
      )
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'))
      digests.push(sha256(writeArtifactArchive(entries)))
      expect(new Set(digests).size).toBe(1)
    } finally {
      if (original === undefined) delete process.env['TZ']
      else process.env['TZ'] = original
    }
  })
})

describe('filesystem sink', () => {
  test('writes atomically and names relative or based URLs', async () => {
    const root = temporaryRoot()
    const sink = createFilesystemArtifactSink({ directory: 'out' }, root)
    const input = {
      body: new TextEncoder().encode('{}'),
      contentType: 'application/json' as const,
      key: 'nested/manifest.json',
      sha256: sha256('{}'),
    }
    expect(sink.name).toBe('filesystem artifact sink')
    await expect(sink.put(input)).resolves.toEqual({
      url: './nested/manifest.json',
    })
    expect(readFileSync(join(root, 'out/nested/manifest.json'), 'utf8')).toBe(
      '{}',
    )
    expect(
      readdirSync(join(root, 'out/nested')).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([])
    const based = createFilesystemArtifactSink(
      { baseUrl: 'https://cdn.example/a', directory: 'out' },
      root,
    )
    await expect(based.put({ ...input, key: 'm.json' })).resolves.toEqual({
      url: 'https://cdn.example/a/m.json',
    })
  })

  test('rejects keys that leave the directory', async () => {
    const root = temporaryRoot()
    const sink = createFilesystemArtifactSink({ directory: 'out' }, root)
    const input = {
      body: new Uint8Array(),
      contentType: 'application/json' as const,
      sha256: sha256(''),
    }
    for (const key of [
      '../escape',
      '/etc/escape',
      'a/../../escape',
      '.',
      '',
      'a\\b',
    ]) {
      await expect(sink.put({ ...input, key })).rejects.toThrow(
        'TIA artifact sink key escapes its directory',
      )
    }
    expect(existsSync(join(root, 'escape'))).toBe(false)
    expect(statSync(root).isDirectory()).toBe(true)
  })

  test('a failed write leaves no temporary file behind', async () => {
    const root = temporaryRoot()
    symlinkSync(join(root, 'missing-target'), join(root, 'blocked'))
    const sink = createFilesystemArtifactSink({ directory: 'blocked' }, root)
    await expect(
      sink.put({
        body: new Uint8Array(),
        contentType: 'application/zip',
        key: 'x.zip',
        sha256: sha256(''),
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(readdirSync(root)).toEqual(['blocked'])
  })
})

describe('credentials', () => {
  test('a rejected signing key never appears in the failure', async () => {
    const { root } = await project()
    const secret = 'super-secret-key-material'
    const failure = await tia({
      artifactId: 'x',
      cacheDir: '.tia/node',
      root,
      runId: 'run',
      signing: { keyId: 'k', privateKey: secret },
    })
      .publish()
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ).not.toContain(secret)
    expect((failure as Error).message).toBe(
      'TIA artifact signing key is not a valid private key',
    )
  })
})
