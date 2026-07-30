import { mergePartitionedGraphs } from '../graph/merge.js'
import {
  commitGraph,
  graphDigest,
  parseGraph,
  readGraph,
} from '../graph/state.js'
import { createGitHubActionsArtifactProvider } from './github-actions.js'
import { createGitLabCiArtifactProvider } from './gitlab-ci.js'
import { createHttpManifestArtifactProvider } from './http-manifest.js'
import { createFilesystemArtifactProvider } from './filesystem.js'
import type {
  TiaArtifactProvider,
  TiaArtifactSource,
  TiaRuntimeGraph,
} from '../shared/types.js'

export interface RestoreArtifactsInput {
  cacheDir: string
  coverageRequested?: boolean
  fingerprint: string
  log: boolean
  providers: TiaArtifactProvider[]
  root?: string
  runner?: string
}

export interface RestoreArtifactResult {
  artifactId?: Array<number | string> | number | string
  provider?: string
  reason: string
  restored: boolean
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
        .map((item) => ({
          graph: parseGraph(item.graph),
          group: item.group,
          id: item.id,
        }))
        .filter(
          (
            item,
          ): item is {
            graph: NonNullable<ReturnType<typeof parseGraph>>
            group: number | string | undefined
            id: number | string
          } =>
            item.graph !== null &&
            item.graph.fingerprint === input.fingerprint,
        )
      const complete = parsed.find((item) =>
        usableGraph(
          item.graph,
          input.fingerprint,
          coverageRequested,
        ),
      )
      let graph = complete?.graph ?? null
      let partitionIds: Array<number | string> = []
      if (graph === null) {
        const groups = new Map<
          number | string | undefined,
          typeof parsed
        >()
        for (const item of parsed) {
          if (item.graph.partition === undefined) {
            continue
          }
          const group = groups.get(item.group) ?? []
          group.push(item)
          groups.set(item.group, group)
        }
        for (const group of groups.values()) {
          graph = mergePartitionedGraphs(
            group.map((item) => item.graph),
          )
          if (graph !== null) {
            partitionIds = group.map((item) => item.id)
            break
          }
        }
      }
      if (
        !usableGraph(
          graph,
          input.fingerprint,
          coverageRequested,
        )
      ) {
        continue
      }
      const ids =
        complete === undefined
          ? partitionIds
          : complete.id

      const committed = await commitGraph(input.cacheDir, {
        expected: local,
        expectedDigest: graphDigest(local),
        graph,
      })
      if (committed.status === 'conflict') {
        return {
          reason:
            usableGraph(
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
      }
    } catch {
      // Artifact restoration is an optimization. The planner below will use a
      // later provider or conservatively record when a source is unavailable.
    }
  }

  return {
    reason: 'no provider returned a compatible artifact',
    restored: false,
  }
}
