import { mergePartitionedGraphs } from '../state/merge.js'
import { commitGraph, graphDigest, readGraph } from '../state/store.js'
import { createGitHubActionsArtifactProvider } from './github-actions.js'
import { createGitLabCiArtifactProvider } from './gitlab-ci.js'
import { createHttpManifestArtifactProvider } from './http-manifest.js'
import { createFilesystemArtifactProvider } from './filesystem.js'
import { parseArtifactGraph } from './portable-graph.js'
import { verifyArtifactAttestation } from './trust.js'
import type { TiaRuntimeGraph } from '../types.js'
import type {
  TiaArtifactProvider,
  TiaArtifactSource,
  TiaArtifactTrustPolicy,
} from './types.js'

export interface RestoreArtifactsInput {
  cacheDir: string
  coverageRequested?: boolean
  fingerprint: string
  log: boolean
  providers: TiaArtifactProvider[]
  root?: string
  runner?: string
  trust?: TiaArtifactTrustPolicy
}

export interface RestoreArtifactResult {
  artifactId?: Array<number | string> | number | string
  provider?: string
  reason: string
  restored: boolean
  trust?: {
    keyId?: string
    reason: string
  }
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
    switch (source.provider) {
      case 'filesystem':
        return createFilesystemArtifactProvider(source)
      case 'github-actions':
        return createGitHubActionsArtifactProvider(source)
      case 'gitlab-ci':
        return createGitLabCiArtifactProvider(source)
      case 'http-manifest':
        return createHttpManifestArtifactProvider(source)
    }
  })
}

export async function restoreGraphFromArtifacts(
  input: RestoreArtifactsInput,
): Promise<RestoreArtifactResult> {
  const local = readGraph(input.cacheDir)
  const coverageRequested = input.coverageRequested ?? false
  if (usableGraph(local, input.fingerprint, coverageRequested)) {
    return { reason: 'compatible local graph exists', restored: false }
  }

  let rejectedForTrust = false
  for (const provider of input.providers) {
    try {
      const candidate = await provider.load({
        fingerprint: input.fingerprint,
        ...(input.root === undefined ? {} : { root: input.root }),
        ...(input.runner === undefined ? {} : { runner: input.runner }),
      })
      if (candidate === null) {
        continue
      }

      const candidates = Array.isArray(candidate) ? candidate : [candidate]
      const parsed = candidates
        .map((item) => {
          const graph = parseArtifactGraph(item.graph)
          if (graph === null) return null
          const trust = verifyArtifactAttestation({
            attestation: item.attestation,
            graph,
            ...(item.graphSha256 === undefined
              ? {}
              : { graphSha256: item.graphSha256 }),
            policy: input.trust ?? { allowUnsigned: true },
            ...(input.runner === undefined ? {} : { runner: input.runner }),
          })
          if (!trust.trusted) {
            rejectedForTrust = true
            if (input.log) {
              console.warn(
                `TIA rejected artifact ${String(item.id)} from ${provider.name}: ${trust.reason}.`,
              )
            }
            return null
          }
          return {
            graph,
            group: item.group,
            id: item.id,
            trust,
          }
        })
        .filter((item) => item !== null)
        .filter(
          (
            item,
          ): item is {
            graph: TiaRuntimeGraph
            group: number | string | undefined
            id: number | string
            trust: ReturnType<typeof verifyArtifactAttestation>
          } =>
            item.graph !== null && item.graph.fingerprint === input.fingerprint,
        )
      const complete = parsed.find((item) =>
        usableGraph(item.graph, input.fingerprint, coverageRequested),
      )
      let graph = complete?.graph ?? null
      let artifactTrust = complete?.trust
      let partitionIds: Array<number | string> = []
      if (graph === null) {
        const groups = new Map<number | string | undefined, typeof parsed>()
        for (const item of parsed) {
          if (item.graph.partition === undefined) {
            continue
          }
          const group = groups.get(item.group) ?? []
          group.push(item)
          groups.set(item.group, group)
        }
        for (const group of groups.values()) {
          graph = mergePartitionedGraphs(group.map((item) => item.graph))
          if (graph !== null) {
            partitionIds = group.map((item) => item.id)
            artifactTrust = group[0]?.trust
            break
          }
        }
      }
      if (!usableGraph(graph, input.fingerprint, coverageRequested)) {
        continue
      }
      const ids = complete === undefined ? partitionIds : complete.id

      const committed = await commitGraph(input.cacheDir, {
        expected: local,
        expectedDigest: graphDigest(local),
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
    } catch {
      // Artifact restoration is an optimization. The planner below will use a
      // later provider or conservatively record when a source is unavailable.
    }
  }

  return {
    reason: rejectedForTrust
      ? 'no provider returned a trusted compatible artifact'
      : 'no provider returned a compatible artifact',
    restored: false,
  }
}
