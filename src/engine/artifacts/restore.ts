import { resolve } from 'node:path'

import * as Match from 'effect/Match'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Predicate from 'effect/Predicate'

import {
  isSafeRunner,
  type RestoreArtifactResult,
  type RestoreArtifactsInput,
  type TiaArtifactCandidate,
  type TiaArtifactProvider,
  type TiaArtifactSource,
} from '../../core/artifacts.ts'
import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { runPromise } from '../../host/runtime.ts'
import { TiaInvalid, TiaIo } from '../../wire/errors.ts'
import { BaselinesLive } from '../baseline/live.ts'
import { Baselines, GraphStore } from '../ports.ts'
import { mergePartitionedGraphs } from '../state/merge.ts'
import { GraphStoreLive } from '../state/graph-store.ts'
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

type ArtifactId = number | string

interface Trusted {
  graph: TiaRuntimeGraph
  group: ArtifactId | undefined
  id: ArtifactId
  trust: TiaArtifactTrustResult
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
 * committed. A provider that fails is skipped; restoring is an optimisation.
 */
export const restoreGraph = Effect.fn('tia.artifacts.restore')(function* (
  input: RestoreArtifactsInput,
): Effect.fn.Return<RestoreArtifactResult, TiaInvalid, Baselines | GraphStore> {
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
      reason: 'compatible local graph exists',
      restored: false,
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
      const groups = new Map<ArtifactId | undefined, Trusted[]>()
      for (const item of trusted) {
        if (item.graph.partition === undefined) continue
        if (!(yield* reachable(item.graph))) continue
        const group = groups.get(item.group) ?? []
        group.push(item)
        groups.set(item.group, group)
      }
      for (const group of groups.values()) {
        graph = mergePartitionedGraphs(group.map((item) => item.graph))
        if (graph !== null) {
          ids = group.map((item) => item.id)
          artifactTrust = group[0]?.trust
          break
        }
      }
    }
    if (!usableGraph(graph, input.fingerprint, coverageRequested)) return null

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
    if (outcome !== null) return outcome
  }

  return {
    reason: rejectedForTrust
      ? 'no provider returned a trusted compatible artifact'
      : 'no provider returned a compatible artifact',
    restored: false,
  }
})

const live = Layer.mergeAll(GraphStoreLive, BaselinesLive)

/** `restoreGraph` over the live graph store and git baselines. */
export function restoreGraphFromArtifacts(
  input: RestoreArtifactsInput,
): Promise<RestoreArtifactResult> {
  return runPromise(restoreGraph(input).pipe(Effect.provide(live)))
}
