import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { strToU8, zipSync } from 'fflate'
import { afterEach } from 'vitest'

import type { RestoreArtifactsInput } from '../../src/core/artifacts.ts'
import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import { readArtifactArchive } from '../../src/engine/artifacts/archive.ts'
import { baselinesMemory } from '../../src/engine/baseline/memory.ts'
import { restoreGraph } from '../../src/engine/artifacts/restore.ts'
import { GraphStore } from '../../src/engine/ports.ts'
import { GraphStoreLive } from '../../src/engine/state/graph-store.ts'
import { baseGraph } from '../engine/support/graphs.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

export function temporaryRoot(prefix = 'tiacore-artifacts-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  directories.push(root)
  return root
}

export function cacheDirectory(): string {
  return join(temporaryRoot(), '.tia')
}

/** A complete graph; the baseline commit is `abc` unless overridden. */
export function graph(
  fingerprint: string,
  overrides: Partial<TiaRuntimeGraph> = {},
): TiaRuntimeGraph {
  return baseGraph({
    baseline: { sha: 'abc', workingTree: {} },
    coverageComplete: true,
    fingerprint,
    ...overrides,
  })
}

export function archive(fingerprint: string): Uint8Array {
  return zipSync({ 'graph.json': strToU8(JSON.stringify(graph(fingerprint))) })
}

/** The graph `archive` holds for `runner`, or null when it holds none. */
export const archiveGraph = (
  bytes: Uint8Array,
  runner: string | undefined,
): TiaRuntimeGraph | null => readArtifactArchive(bytes, runner)?.graph ?? null

export const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')

const stores = GraphStoreLive.pipe(Layer.provideMerge(NodeServices.layer))

/** Runs an effect over the live graph store and the Node platform. */
export const runStored = <A, E>(
  program: Effect.Effect<A, E, GraphStore | NodeServices.NodeServices>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(stores)))

export function readStored(cacheDir: string): Promise<TiaRuntimeGraph | null> {
  return runStored(
    Effect.gen(function* () {
      const store = yield* GraphStore
      return (yield* store.read(cacheDir)).graph
    }),
  )
}

export function writeStored(
  cacheDir: string,
  value: TiaRuntimeGraph,
): Promise<void> {
  return runStored(
    Effect.gen(function* () {
      const store = yield* GraphStore
      yield* store.purge(cacheDir)
      yield* store.commit(cacheDir, {
        expected: null,
        expectedDigest: null,
        graph: value,
      })
    }),
  )
}

/**
 * Restores with a project whose history holds `commits` (HEAD is the last), so
 * ancestry can be decided without a git repository.
 */
export function restore(
  input: RestoreArtifactsInput,
  commits: readonly string[] = ['abc'],
) {
  const root = resolve(input.root ?? process.cwd())
  const projects = new Map([
    [
      root,
      {
        commits: commits.map((sha) => ({ files: {}, sha })),
        files: {},
      },
    ],
  ])
  return Effect.runPromise(
    restoreGraph({ ...input, root }).pipe(
      Effect.provide(
        Layer.mergeAll(GraphStoreLive, baselinesMemory(projects)).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  )
}

export const keys = generateKeyPairSync('ed25519')
export const privateKeyPem = keys.privateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString()
export const publicKeyPem = keys.publicKey
  .export({ format: 'pem', type: 'spki' })
  .toString()
