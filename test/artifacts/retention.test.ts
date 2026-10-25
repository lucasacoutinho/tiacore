import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  archiveKey,
  pruneCandidates,
  RETENTION_GRACE_MS,
} from '../../src/core/artifact-retention.ts'
import {
  MAX_MANIFEST_BYTES,
  type TiaArtifactCandidate,
  type TiaArtifactClaimV1,
  type TiaArtifactProvider,
  type TiaArtifactRetentionOptions,
} from '../../src/core/artifacts.ts'
import {
  createFilesystemArtifactProvider,
  loadFilesystemArtifacts,
} from '../../src/engine/artifacts/filesystem.ts'
import {
  createFilesystemArtifactSink,
  tia,
} from '../../src/engine/artifacts/publisher.ts'
import { pruneArtifactDirectory } from '../../src/engine/artifacts/retention.ts'
import { putToDirectory } from '../../src/engine/artifacts/sink.ts'
import { createArtifactAttestation } from '../../src/engine/artifacts/trust.ts'
import { GraphStoreLive } from '../../src/engine/state/graph-store.ts'
import {
  archive as unsignedArchive,
  graph as baseGraph,
  privateKeyPem,
  publicKeyPem,
  restore,
  sha256,
  temporaryRoot,
  writeStored,
} from './support.ts'

// Bounded retention of the filesystem artifact sink. Modification times are the
// clock: a test makes an archive old with utimes instead of waiting.

const signing = { keyId: 'fixture-key', privateKey: privateKeyPem }
const HOUR = 3_600
const DAY = 24 * HOUR

afterEach(() => {
  vi.useRealTimers()
})

/** A name the publisher could have given an archive; `n` picks the digest. */
const digestOf = (n: number): string =>
  n.toString(16).padStart(24, '0').padEnd(64, '0')
const nameOf = (n: number): string => archiveKey(digestOf(n))

function setAge(path: string, seconds: number): void {
  const time = (Date.now() - seconds * 1_000) / 1_000
  utimesSync(path, time, time)
}

/** Writes a file `seconds` old; `body` defaults to a valid unsigned archive. */
function plant(
  directory: string,
  name: string,
  seconds: number,
  body: Uint8Array = unsignedArchive('retention'),
): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, body)
  setAge(path, seconds)
  return path
}

/** An archive holding only the attestation a pruner reads. */
function attested(claim: Partial<TiaArtifactClaimV1>): Uint8Array {
  const attestation = createArtifactAttestation(
    {
      expiresAt: new Date(Date.now() + 7 * DAY * 1_000).toISOString(),
      fingerprint: 'retention',
      graphSha256: sha256('graph'),
      issuedAt: new Date().toISOString(),
      lineage: {
        baseline: { sha: 'abc' },
        parents: [],
        producedAt: new Date().toISOString(),
        runId: 'run',
      },
      promoted: false,
      ...claim,
    },
    signing,
  )
  return zipSync({
    'attestation.json': strToU8(JSON.stringify(attestation)),
  })
}

const archivesIn = (directory: string): string[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.zip'))
    .sort()

/** Makes every archive in `directory` an hour older, keeping their order. */
function ageAll(directory: string): void {
  if (!existsSync(directory)) return
  for (const name of archivesIn(directory)) {
    const path = join(directory, name)
    const time = statSync(path).mtimeMs / 1_000 - HOUR
    utimesSync(path, time, time)
  }
}

function manifestOf(...archives: Array<{ sha: string; url?: string }>) {
  return strToU8(
    JSON.stringify({
      artifacts: archives.map(({ sha, url }, index) => ({
        id: `build-${index}`,
        sha256: sha,
        url: url ?? `./${archiveKey(sha)}`,
      })),
      generatedAt: new Date().toISOString(),
      version: 1,
    }),
  )
}

async function publisherProject(fingerprint = 'node-22-linux') {
  const root = temporaryRoot('tiacore-retention-')
  const cacheDir = join(root, '.tia/node')
  const stored = (name: string) =>
    writeStored(
      cacheDir,
      baseGraph(name, {
        baseline: { sha: 'baseline-abc', source: 'git', workingTree: {} },
      }),
    )
  await stored(fingerprint)
  const output = join(root, 'out')

  /** Publishes (or promotes) once and returns the archive's name. */
  async function publish(
    index: number,
    options: {
      fingerprint?: string
      promote?: boolean
      retention?: TiaArtifactRetentionOptions | false
      runner?: string
    } = {},
  ): Promise<string> {
    if (options.fingerprint !== undefined) await stored(options.fingerprint)
    ageAll(output)
    const publisher = tia({
      artifactId: `build-${index}`,
      cacheDir: '.tia/node',
      filesystem: {
        directory: 'out',
        ...(options.retention === undefined
          ? {}
          : { retention: options.retention }),
      },
      root,
      runId: `run-${index}`,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      signing,
    })
    const receipt = await (options.promote === true
      ? publisher.promote()
      : publisher.publish())
    return archiveKey(receipt.sha256)
  }
  return { output, publish, root }
}

describe('which archives retention may prune', () => {
  const policy = { keep: 2, maxAgeMs: undefined }
  const now = 1_000_000_000_000
  const aged = (key: string, seconds: number) => ({
    key,
    modifiedMs: now - seconds * 1_000,
  })

  test('returns everything past the newest keep, newest first', () => {
    const archives = [
      aged('d', 4 * HOUR),
      aged('a', HOUR),
      aged('c', 3 * HOUR),
      aged('b', 2 * HOUR),
    ]
    expect(
      pruneCandidates(archives, policy, now, new Set()).map(({ key }) => key),
    ).toEqual(['c', 'd'])
  })

  test('orders equal modification times by name', () => {
    const archives = [aged('b', HOUR), aged('a', HOUR), aged('c', HOUR)]
    expect(
      pruneCandidates(
        archives,
        { keep: 1, maxAgeMs: undefined },
        now,
        new Set(),
      ).map(({ key }) => key),
    ).toEqual(['b', 'c'])
  })

  test('adds archives older than the age limit even inside the window', () => {
    const archives = [aged('a', HOUR), aged('b', 3 * DAY)]
    expect(
      pruneCandidates(
        archives,
        { keep: 5, maxAgeMs: 2 * DAY * 1_000 },
        now,
        new Set(),
      ).map(({ key }) => key),
    ).toEqual(['b'])
  })

  test('never offers a shielded archive or one inside the grace period', () => {
    const grace = RETENTION_GRACE_MS / 1_000
    const archives = [
      aged('a', HOUR),
      aged('b', 2 * HOUR),
      aged('shielded', 3 * HOUR),
      aged('young', grace - 1),
      aged('future', -HOUR),
      aged('edge', grace),
    ]
    expect(
      pruneCandidates(
        archives,
        { keep: 1, maxAgeMs: undefined },
        now,
        new Set(['shielded']),
      ).map(({ key }) => key),
    ).toEqual(['edge', 'a', 'b'])
  })
})

describe('filesystem sink retention', () => {
  test('keeps the newest archives after more than that many publishes', async () => {
    const { output, publish } = await publisherProject()
    const published: string[] = []
    for (let index = 1; index <= 6; index += 1) {
      published.push(await publish(index, { retention: { keep: 3 } }))
      expect(archivesIn(output)).toHaveLength(Math.min(index, 3))
    }
    expect(archivesIn(output)).toEqual(published.slice(-3).sort())
    expect(existsSync(join(output, 'manifest.json'))).toBe(true)
  })

  test('keeps the newest 20 by default and leaves the rest of the directory alone', async () => {
    const { output, publish } = await publisherProject()
    for (let n = 0; n < 24; n += 1) plant(output, nameOf(n), (24 - n) * HOUR)
    const latest = await publish(1)
    expect(archivesIn(output)).toEqual(
      [latest, ...Array.from({ length: 19 }, (_, n) => nameOf(n + 5))].sort(),
    )
  })

  test('does not prune an archive written inside the grace period', async () => {
    const { output, root } = await publisherProject()
    const sink = createFilesystemArtifactSink(
      { directory: 'out', retention: { keep: 1 } },
      root,
    )
    const put = () =>
      sink.put({
        body: manifestOf({ sha: digestOf(99) }),
        contentType: 'application/json',
        key: 'manifest.json',
        sha256: sha256('m'),
      })
    plant(output, nameOf(1), 60)
    plant(output, nameOf(2), 120)
    plant(output, nameOf(3), 180)
    await put()
    expect(archivesIn(output)).toEqual([nameOf(1), nameOf(2), nameOf(3)])
    setAge(join(output, nameOf(2)), 2 * HOUR)
    setAge(join(output, nameOf(3)), 3 * HOUR)
    await put()
    expect(archivesIn(output)).toEqual([nameOf(1)])
  })

  test('keeps an archive the manifest lists by digest or by url', async () => {
    const { output, root } = await publisherProject()
    const sink = createFilesystemArtifactSink(
      { directory: 'out', retention: { keep: 1 } },
      root,
    )
    plant(output, nameOf(1), HOUR)
    plant(output, nameOf(2), 2 * HOUR)
    plant(output, nameOf(3), 3 * HOUR)
    plant(output, nameOf(4), 4 * HOUR)
    await sink.put({
      body: manifestOf(
        { sha: digestOf(3) },
        {
          sha: sha256('elsewhere'),
          url: `https://cdn.example/tia/${nameOf(4)}?sig=abc`,
        },
      ),
      contentType: 'application/json',
      key: 'manifest.json',
      sha256: sha256('m'),
    })
    expect(archivesIn(output)).toEqual([nameOf(1), nameOf(3), nameOf(4)])
  })

  test('keeps what the manifest on disk lists after a concurrent publish replaced it', async () => {
    const { output } = await publisherProject()
    plant(output, nameOf(1), HOUR)
    plant(output, nameOf(2), 2 * HOUR)
    plant(output, nameOf(3), 3 * HOUR)
    writeFileSync(
      join(output, 'manifest.json'),
      manifestOf({ sha: digestOf(2) }),
    )
    await Effect.runPromise(
      pruneArtifactDirectory(
        output,
        { keep: 1, maxAgeMs: undefined },
        manifestOf({ sha: digestOf(1) }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
    expect(archivesIn(output)).toEqual([nameOf(1), nameOf(2)])
  })

  test('prunes nothing when the manifest is not a version 1 manifest', async () => {
    const { output, root } = await publisherProject()
    const sink = createFilesystemArtifactSink(
      { directory: 'out', retention: { keep: 1 } },
      root,
    )
    for (let n = 1; n <= 4; n += 1) plant(output, nameOf(n), n * HOUR)
    await sink.put({
      body: strToU8('{}'),
      contentType: 'application/json',
      key: 'manifest.json',
      sha256: sha256('{}'),
    })
    expect(archivesIn(output)).toHaveLength(4)
  })

  test('prunes nothing when the manifest is larger than a consumer reads', async () => {
    const { output, root } = await publisherProject()
    const sink = createFilesystemArtifactSink(
      { directory: 'out', retention: { keep: 1 } },
      root,
    )
    for (let n = 1; n <= 4; n += 1) plant(output, nameOf(n), n * HOUR)
    const body = new Uint8Array(MAX_MANIFEST_BYTES + 1).fill(0x20)
    body.set(manifestOf({ sha: digestOf(1) }))
    await sink.put({
      body,
      contentType: 'application/json',
      key: 'manifest.json',
      sha256: sha256(body),
    })
    expect(archivesIn(output)).toHaveLength(4)
  })

  test('prunes only when a manifest is written', async () => {
    const { output, root } = await publisherProject()
    const sink = createFilesystemArtifactSink(
      { directory: 'out', retention: { keep: 1 } },
      root,
    )
    for (let n = 1; n <= 3; n += 1) plant(output, nameOf(n), n * HOUR)
    const body = unsignedArchive('retention')
    await sink.put({
      body,
      contentType: 'application/zip',
      key: nameOf(9),
      sha256: sha256(body),
    })
    expect(archivesIn(output)).toHaveLength(4)
  })

  test('touches only archive files directly in the directory', async () => {
    const { output, publish } = await publisherProject()
    const other = plant(output, 'other.zip', 9 * DAY)
    plant(output, 'tiacore-abc.zip', 9 * DAY)
    plant(output, nameOf(1).toUpperCase(), 9 * DAY)
    plant(output, 'state.json', 9 * DAY, strToU8('{}'))
    plant(join(output, 'node'), nameOf(2), 9 * DAY)
    mkdirSync(join(output, nameOf(3)))
    symlinkSync(other, join(output, nameOf(4)))
    for (let n = 5; n < 9; n += 1) plant(output, nameOf(n), (10 - n) * DAY)
    const latest = await publish(1, { retention: { keep: 1 } })
    expect(readdirSync(output).sort()).toEqual(
      [
        'manifest.json',
        'node',
        'other.zip',
        'state.json',
        'tiacore-abc.zip',
        nameOf(1).toUpperCase(),
        nameOf(3),
        nameOf(4),
        latest,
      ].sort(),
    )
    expect(existsSync(join(output, 'node', nameOf(2)))).toBe(true)
  })

  test('retention false keeps every archive', async () => {
    const { output, publish } = await publisherProject()
    for (let n = 0; n < 25; n += 1) plant(output, nameOf(n), (30 - n) * HOUR)
    await publish(1, { retention: false })
    expect(archivesIn(output)).toHaveLength(26)
  })

  test('maxAgeDays prunes old archives inside the window and spares promoted ones', async () => {
    const { output, publish } = await publisherProject()
    plant(output, nameOf(1), 40 * DAY)
    plant(output, nameOf(2), 20 * DAY)
    plant(output, nameOf(3), 40 * DAY, attested({ promoted: true }))
    const latest = await publish(1, { retention: { keep: 10, maxAgeDays: 30 } })
    expect(archivesIn(output)).toEqual([latest, nameOf(2), nameOf(3)].sort())
  })

  test('rejects options that would keep nothing or never expire', () => {
    const root = temporaryRoot()
    for (const keep of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createFilesystemArtifactSink({ retention: { keep } }, root),
      ).toThrow('TIA artifact retention keep must be a positive integer')
    }
    for (const maxAgeDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createFilesystemArtifactSink({ retention: { maxAgeDays } }, root),
      ).toThrow('TIA artifact retention maxAgeDays must be a positive number')
    }
    expect(() =>
      tia({
        artifactId: 'a',
        filesystem: { retention: { keep: 0 } },
        runId: 'r',
        signing,
      }),
    ).toThrow('TIA artifact retention keep must be a positive integer')
  })
})

describe('promoted archives under retention', () => {
  test('the newest promoted archive survives churn and an older one does not', async () => {
    const { output, publish } = await publisherProject()
    const first = await publish(1, { promote: true, retention: { keep: 2 } })
    const second = await publish(2, { promote: true, retention: { keep: 2 } })
    const plain: string[] = []
    for (let index = 3; index <= 8; index += 1) {
      plain.push(await publish(index, { retention: { keep: 2 } }))
    }
    expect(archivesIn(output)).toEqual([second, ...plain.slice(-2)].sort())
    expect(existsSync(join(output, first))).toBe(false)
  })

  test('keeps the newest promoted archive of each fingerprint and runner', async () => {
    const { output, publish } = await publisherProject()
    const node = await publish(1, { promote: true, runner: 'node' })
    const alpha = await publish(2, { fingerprint: 'alpha', promote: true })
    const beta = await publish(3, { fingerprint: 'beta', promote: true })
    const options = { fingerprint: 'plain', retention: { keep: 1 } }
    await publish(4, options)
    const last = await publish(5, options)
    expect(archivesIn(output)).toEqual([alpha, beta, last, node].sort())
  })

  test('an expired promoted archive is not kept', async () => {
    const { output, publish } = await publisherProject()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
    const stale = await publish(1, { promote: true })
    vi.useRealTimers()
    await publish(2, { retention: { keep: 1 } })
    const latest = await publish(3, { retention: { keep: 1 } })
    expect(archivesIn(output)).toEqual([latest])
    expect(existsSync(join(output, stale))).toBe(false)
  })

  test('an archive that cannot be parsed is not kept as promoted', async () => {
    const { output, publish } = await publisherProject()
    plant(output, nameOf(1), 3 * DAY, strToU8('not a zip'))
    plant(
      output,
      nameOf(2),
      2 * DAY,
      zipSync({ 'attestation.json': strToU8('{}') }),
    )
    const latest = await publish(1, { retention: { keep: 1 } })
    expect(archivesIn(output)).toEqual([latest])
  })

  test('finds a promoted attestation stored under .tia/', async () => {
    const { output, publish } = await publisherProject()
    const nested = zipSync({
      '.tia/attestation.json': unzipSync(attested({ promoted: true }))[
        'attestation.json'
      ]!,
    })
    plant(output, nameOf(1), 3 * DAY, nested)
    plant(output, nameOf(2), 2 * DAY)
    const latest = await publish(1, { retention: { keep: 1 } })
    expect(archivesIn(output)).toEqual([latest, nameOf(1)].sort())
  })

  test('keeps the newest promoted archive of at most 32 fingerprints', async () => {
    const { output, publish } = await publisherProject()
    for (let n = 0; n < 40; n += 1) {
      plant(
        output,
        nameOf(n),
        (50 - n) * HOUR,
        attested({ fingerprint: `claimed-${n}`, promoted: true }),
      )
    }
    const latest = await publish(1, { retention: { keep: 1 } })
    const kept = archivesIn(output)
    expect(kept).toHaveLength(33)
    expect(kept).toContain(latest)
    // The newest claims win: 39 down to 8.
    expect(kept).toContain(nameOf(39))
    expect(kept).toContain(nameOf(8))
    expect(kept).not.toContain(nameOf(7))
  })
})

describe('restoring from a pruned directory', () => {
  test('still finds the promoted baseline after it falls out of the window', async () => {
    const { output, publish, root } = await publisherProject()
    const promoted = await publish(1, { promote: true, retention: { keep: 2 } })
    for (let index = 2; index <= 7; index += 1) {
      await publish(index, { retention: { keep: 2 } })
    }
    expect(archivesIn(output)).toHaveLength(3)

    const result = await restore(
      {
        cacheDir: join(root, 'restored'),
        fingerprint: 'node-22-linux',
        log: false,
        providers: [createFilesystemArtifactProvider({ paths: ['out'] })],
        root,
        trust: {
          publicKeys: { 'fixture-key': publicKeyPem },
          requirePromoted: true,
        },
      },
      ['baseline-abc'],
    )
    expect(result).toMatchObject({
      artifactId: join(output, promoted),
      restored: true,
    })
  })
})

describe('a reader meets an archive being pruned', () => {
  const context = { fingerprint: 'retention' }

  /** Loads the directory with `victim` deleted just before its bytes are read. */
  const loadWithVanishing = (
    root: string,
    victim: string,
  ): Promise<TiaArtifactCandidate[]> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* FileSystem.FileSystem
        const racing: FileSystem.FileSystem = {
          ...live,
          readFile: (path, ...rest) =>
            Effect.suspend(() => {
              if (path === victim) rmSync(path)
              return live.readFile(path, ...rest)
            }),
        }
        return yield* loadFilesystemArtifacts(
          { ...context, root },
          { paths: ['out'] },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, racing),
          Effect.provide(GraphStoreLive),
        )
      }).pipe(Effect.provide(NodeServices.layer)),
    )

  test('skips the vanished archive and loads the others', async () => {
    const root = temporaryRoot()
    const out = join(root, 'out')
    const gone = plant(out, nameOf(1), HOUR)
    const stays = plant(out, nameOf(2), 2 * HOUR)
    const candidates = await loadWithVanishing(root, gone)
    expect(candidates.map(({ id }) => id)).toEqual([stays])
    expect(existsSync(gone)).toBe(false)
  })

  test('restore falls back to another archive, or to a full run', async () => {
    const root = temporaryRoot()
    const out = join(root, 'out')
    const gone = plant(out, nameOf(1), HOUR)
    const stays = plant(out, nameOf(2), 2 * HOUR)
    const provider = (victim: string): TiaArtifactProvider => ({
      load: () => loadWithVanishing(root, victim),
      name: 'filesystem artifacts',
    })
    const input = {
      cacheDir: join(root, 'restored'),
      fingerprint: 'retention',
      log: false,
      root,
      trust: { allowUnsigned: true },
    }
    await expect(
      restore({ ...input, providers: [provider(gone)] }),
    ).resolves.toMatchObject({ artifactId: stays, restored: true })

    rmSync(join(root, 'restored'), { force: true, recursive: true })
    await expect(
      restore({ ...input, providers: [provider(stays)] }),
    ).resolves.toEqual({
      reason: 'no provider returned a compatible artifact',
      restored: false,
    })
  })

  test('concurrent loads and a pruning publish never fail', async () => {
    const { output, publish, root } = await publisherProject()
    for (let n = 0; n < 60; n += 1) plant(output, nameOf(n), (70 - n) * HOUR)
    const provider = createFilesystemArtifactProvider({ paths: ['out'] })
    const loads = Array.from({ length: 12 }, () =>
      provider.load({ fingerprint: 'node-22-linux', root }),
    )
    const [, ...loaded] = await Promise.all([
      publish(1, { retention: { keep: 1 } }),
      ...loads,
    ])
    for (const candidates of loaded) {
      expect(Array.isArray(candidates)).toBe(true)
    }
    expect(archivesIn(output)).toHaveLength(1)
  })
})

/** Runs `program` over the real file system with `overrides` applied. */
const withFileSystem = <A>(
  overrides: (live: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
  program: Effect.Effect<A, unknown, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* FileSystem.FileSystem
      return yield* program.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...live,
          ...overrides(live),
        }),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )

describe('a prune that fails', () => {
  const manifest = manifestOf({ sha: digestOf(1) })

  test('leaves the archive that cannot be removed and removes the rest', async () => {
    const root = temporaryRoot()
    const out = join(root, 'out')
    plant(out, nameOf(1), HOUR)
    const stuck = plant(out, nameOf(2), 2 * HOUR)
    plant(out, nameOf(3), 3 * HOUR)
    writeFileSync(join(out, 'manifest.json'), manifest)
    await withFileSystem(
      (live) => ({
        remove: (path, options) =>
          path === stuck
            ? live.remove(join(path, 'not-a-directory'))
            : live.remove(path, options),
      }),
      pruneArtifactDirectory(out, { keep: 1, maxAgeMs: undefined }, manifest),
    )
    expect(archivesIn(out)).toEqual([nameOf(1), nameOf(2)])
  })

  test('never fails the write of the manifest', async () => {
    const root = temporaryRoot()
    const out = join(root, 'out')
    plant(out, nameOf(1), HOUR)
    plant(out, nameOf(2), 2 * HOUR)
    const listings: Array<
      (live: FileSystem.FileSystem) => FileSystem.FileSystem['readDirectory']
    > = [
      (live) => () => live.readDirectory(join(out, 'nowhere')),
      () => () => Effect.die(new Error('listing exploded')),
    ]
    for (const listing of listings) {
      await expect(
        withFileSystem(
          (live) => ({ readDirectory: listing(live) }),
          putToDirectory(
            out,
            undefined,
            {
              body: manifest,
              contentType: 'application/json',
              key: 'manifest.json',
              sha256: sha256(manifest),
            },
            { keep: 1 },
          ),
        ),
      ).resolves.toEqual({ url: './manifest.json' })
      expect(readFileSync(join(out, 'manifest.json'))).toEqual(
        Buffer.from(manifest),
      )
      expect(archivesIn(out)).toHaveLength(2)
    }
  })
})
