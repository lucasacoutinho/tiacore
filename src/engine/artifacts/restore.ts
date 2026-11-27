import { resolve } from 'node:path'

import * as Match from 'effect/Match'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'

import {
  isSafeRunner,
  type RestoreArtifactResult,
  type RestoreArtifactsInput,
  type TiaArtifactCandidate,
  type TiaArtifactProvider,
  type TiaArtifactSource,
} from '../../core/artifacts.ts'
import type {
  TiaRuntimeGraph,
  TiaRuntimeGraphPartition,
} from '../../core/runtime.ts'
import { TiaInvalid, TiaIo } from '../../wire/errors.ts'
import { Baselines, GraphStore, type StoredGraph } from '../ports.ts'
import { mergePartitionedFragments } from '../state/merge.ts'
import { createFilesystemArtifactProvider } from './filesystem.ts'
import { createGitHubActionsArtifactProvider } from './github-actions.ts'
import { createGitLabCiArtifactProvider } from './gitlab-ci.ts'
import { createHttpManifestArtifactProvider } from './http-manifest.ts'
import { parseArtifactGraph } from './portable-graph.ts'
import {
  type TiaArtifactTrustResult,
  verifyArtifactAttestation,
} from './trust.ts'

export type { RestoreArtifactResult, RestoreArtifactsInput }

/**
 * A restore's result, and the graph it read from the cache directory when it
 * committed nothing there (null after a commit was tried), so a caller need
 * not read that graph again.
 */
export interface RestoreKeeping {
  readonly kept: StoredGraph | null
  readonly result: RestoreArtifactResult
}

type ArtifactId = number | string

interface Trusted {
  graph: TiaRuntimeGraph
  group: ArtifactId | undefined
  id: ArtifactId
  trust: TiaArtifactTrustResult
}

/**
 * What the partition merge compares, as a key: within one provider group,
 * fragments with different keys never merge, so each key is tried on its own.
 */
function mergeSetKey(
  graph: TiaRuntimeGraph,
  partition: TiaRuntimeGraphPartition,
): string {
  return JSON.stringify([
    partition.group ?? null,
    partition.total,
    graph.baseline,
    graph.fingerprint,
  ])
}

function isProvider(source: TiaArtifactSource): source is TiaArtifactProvider {
  return 'load' in source && typeof source.load === 'function'
}

function usableGraph(
  graph: TiaRuntimeGraph | null,
  fingerprint: string,
  coverageRequested: boolean,
): graph is TiaRuntimeGraph {
  return (
    graph !== null &&
    graph.fingerprint === fingerprint &&
    graph.complete &&
    (!coverageRequested || graph.coverageComplete)
  )
}

export function artifactProviders(
  sources: TiaArtifactSource | TiaArtifactSource[] | undefined,
): TiaArtifactProvider[] {
  if (sources === undefined) {
    return []
  }

  return (Array.isArray(sources) ? sources : [sources]).map((source) => {
    if (isProvider(source)) return source
    return Match.value(source).pipe(
      Match.discriminatorsExhaustive('provider')({
        filesystem: createFilesystemArtifactProvider,
        'github-actions': createGitHubActionsArtifactProvider,
        'gitlab-ci': createGitLabCiArtifactProvider,
        'http-manifest': createHttpManifestArtifactProvider,
      }),
    )
  })
}

/**
 * Loads from a user's provider, which may return a value, a promise or throw.
 * Anything it returns that is not a candidate object is dropped.
 */
const loadCandidates = (
  provider: TiaArtifactProvider,
  input: RestoreArtifactsInput,
) =>
  Effect.tryPromise({
    catch: () => new TiaIo({ message: 'TIA artifact provider failed' }),
    try: async () =>
      provider.load({
        fingerprint: input.fingerprint,
        ...(input.root === undefined ? {} : { root: input.root }),
        ...(input.runner === undefined ? {} : { runner: input.runner }),
      }),
  }).pipe(
    Effect.map((loaded): TiaArtifactCandidate[] =>
      (Array.isArray(loaded) ? loaded : [loaded]).filter(
        (item): item is TiaArtifactCandidate => Predicate.isObject(item),
      ),
    ),
  )

/**
 * Restores a graph from the first provider that supplies a trusted, compatible
 * artifact and commits it to the cache.
 *
 * A candidate is used only when it passes, in order: graph parsing, the trust
 * policy (unsigned artifacts fail unless the policy allows them), the
 * fingerprint, and, unless its baseline came from a file snapshot, ancestry:
 * its baseline commit must be an ancestor of HEAD. A graph whose baseline is
 * not reachable from HEAD could only force a full run, so it is not
 * committed. Without a complete graph, partition fragments are merged one set
 * at a time: the fragments their provider put in one group (a CI run, say)
 * that share a `mergeSetKey`. A stray fragment never blocks a complete set,
 * and only the fragments merged are reported. A provider that fails is
 * skipped; restoring is an optimisation.
 */
export const restoreGraph = (input: RestoreArtifactsInput) =>
  restoreKeeping(input).pipe(Effect.map(({ result }) => result))

/** `restoreGraph`, also returning the local graph it kept. */
export const restoreKeeping = Effect.fn('tia.artifacts.restore')(function* (
  input: RestoreArtifactsInput,
): Effect.fn.Return<RestoreKeeping, TiaInvalid, Baselines | GraphStore> {
  if (input.runner !== undefined && !isSafeRunner(input.runner)) {
    return yield* new TiaInvalid({
      message: 'TIA artifact runner must be a safe relative path',
    })
  }
  const store = yield* GraphStore
  const baselines = yield* Baselines
  const root = resolve(input.root ?? process.cwd())
  const local = yield* store.read(input.cacheDir)
  const coverageRequested = input.coverageRequested ?? false
  if (usableGraph(local.graph, input.fingerprint, coverageRequested)) {
    return {
      kept: local,
      result: { reason: 'compatible local graph exists', restored: false },
    }
  }

  const head = yield* baselines.currentSha(root)
  const ancestry = new Map<string, boolean>()
  const reachable = Effect.fnUntraced(function* (graph: TiaRuntimeGraph) {
    if (graph.baseline.source === 'filesystem') return true
    if (head === null) return false
    const known = ancestry.get(graph.baseline.sha)
    if (known !== undefined) return known
    const ancestral = yield* baselines.isAncestor(
      root,
      graph.baseline.sha,
      head,
    )
    ancestry.set(graph.baseline.sha, ancestral)
    return ancestral
  })

  let rejectedForTrust = false
  // Once a commit was tried, the cache directory may hold another graph.
  let committing = false
  const tryProvider = Effect.fnUntraced(function* (
    provider: TiaArtifactProvider,
  ) {
    const candidates = yield* loadCandidates(provider, input)
    const trusted: Trusted[] = []
    for (const item of candidates) {
      const graph = parseArtifactGraph(item.graph)
      if (graph === null) continue
      const trust = verifyArtifactAttestation({
        attestation: item.attestation,
        graph,
        ...(item.graphSha256 === undefined
          ? {}
          : { graphSha256: item.graphSha256 }),
        policy: input.trust ?? {},
        ...(input.runner === undefined ? {} : { runner: input.runner }),
      })
      if (!trust.trusted) {
        rejectedForTrust = true
        if (input.log) {
          console.warn(
            `TIA rejected artifact ${String(item.id)} from ${provider.name}: ${trust.reason}.`,
          )
        }
        continue
      }
      if (graph.fingerprint !== input.fingerprint) continue
      trusted.push({ graph, group: item.group, id: item.id, trust })
    }

    let chosen: Trusted | undefined
    for (const item of trusted) {
      if (
        usableGraph(item.graph, input.fingerprint, coverageRequested) &&
        (yield* reachable(item.graph))
      ) {
        chosen = item
        break
      }
    }
    let graph = chosen?.graph ?? null
    let artifactTrust = chosen?.trust
    let ids: ArtifactId | ArtifactId[] = chosen?.id ?? []
    if (graph === null) {
      const groups = new Map<ArtifactId | undefined, Map<string, Trusted[]>>()
      for (const item of trusted) {
        const partition = item.graph.partition
        if (partition === undefined) continue
        if (!(yield* reachable(item.graph))) continue
        const sets = groups.get(item.group) ?? new Map<string, Trusted[]>()
        const key = mergeSetKey(item.graph, partition)
        sets.set(key, [...(sets.get(key) ?? []), item])
        groups.set(item.group, sets)
      }
      const sets = [...groups.values()].flatMap((byKey) => [...byKey.values()])
      for (const set of sets) {
        const merge = mergePartitionedFragments(set.map((item) => item.graph))
        if (
          merge === null ||
          !usableGraph(merge.graph, input.fingerprint, coverageRequested)
        ) {
          continue
        }
        const used = new Set(merge.used)
        const merged = set.filter((_, position) => used.has(position))
        graph = merge.graph
        ids = merged.map((item) => item.id)
        artifactTrust = merged[0]?.trust
        break
      }
    }
    if (!usableGraph(graph, input.fingerprint, coverageRequested)) return null

    committing = true
    const committed = yield* store.commit(input.cacheDir, {
      expected: local.graph,
      expectedDigest: local.digest,
      graph,
    })
    if (committed.status === 'conflict') {
      return {
        reason: usableGraph(
          committed.graph,
          input.fingerprint,
          coverageRequested,
        )
          ? 'compatible local graph won artifact restore race'
          : 'concurrent graph update prevented artifact restore',
        restored: false,
      }
    }
    if (input.log) {
      console.log(
        `TIA restored artifact ${
          Array.isArray(ids) ? ids.map(String).join(', ') : String(ids)
        } from ${provider.name}.`,
      )
    }
    return {
      artifactId: ids,
      provider: provider.name,
      reason: 'compatible artifact restored',
      restored: true,
      ...(artifactTrust === undefined
        ? {}
        : {
            trust: {
              ...(artifactTrust.keyId === undefined
                ? {}
                : { keyId: artifactTrust.keyId }),
              reason: artifactTrust.reason,
            },
          }),
    }
  })

  for (const provider of input.providers) {
    const outcome = yield* tryProvider(provider).pipe(
      Effect.orElseSucceed(() => null),
    )
    if (outcome !== null) return { kept: null, result: outcome }
  }

  return {
    kept: committing ? null : local,
    result: {
      reason: rejectedForTrust
        ? 'no provider returned a trusted compatible artifact'
        : 'no provider returned a compatible artifact',
      restored: false,
    },
  }
})
