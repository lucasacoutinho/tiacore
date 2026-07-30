import { strFromU8, unzipSync } from 'fflate'
import picomatch from 'picomatch'

import { parseGraph } from '../graph/state.js'
import type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaArtifactProviderContext,
  TiaGitHubActionsOptions,
  TiaGraph,
} from '../shared/types.js'

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
const MAX_GRAPH_BYTES = 20 * 1024 * 1024

interface GitHubArtifact {
  archive_download_url: string
  created_at: string
  expired: boolean
  id: number
  name: string
  size_in_bytes: number
  workflow_run?: {
    head_branch?: string
    id?: number
  }
}

interface GitHubArtifactList {
  artifacts: GitHubArtifact[]
}

interface NormalizedGitHubActionsOptions {
  apiUrl: string
  artifactName: string
  branch: string | null
  maxArtifacts: number
  repository: string | null
  runId: string | null
  tokenEnv: string
}

function normalizedOptions(
  options: TiaGitHubActionsOptions,
): NormalizedGitHubActionsOptions {
  return {
    apiUrl: options.apiUrl ?? 'https://api.github.com',
    artifactName: options.artifactName ?? 'tiacore',
    branch: options.branch ?? null,
    maxArtifacts: Math.max(
      1,
      Math.min(100, options.maxArtifacts ?? 20),
    ),
    repository:
      options.repository ?? process.env.GITHUB_REPOSITORY ?? null,
    runId:
      options.runId === undefined ? null : String(options.runId),
    tokenEnv: options.tokenEnv ?? 'GITHUB_TOKEN',
  }
}

function repositoryParts(repository: string | null): [string, string] | null {
  if (repository === null) {
    return null
  }

  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository)
  return match === null ? null : [match[1]!, match[2]!]
}

function headers(token: string | undefined): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    ...(token === undefined || token === ''
      ? {}
      : { Authorization: `Bearer ${token}` }),
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

export function archiveGraph(
  archive: Uint8Array,
  runner: string | undefined,
): TiaGraph | null {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    return null
  }

  const paths = [
    ...(runner === undefined
      ? ['graph.json', '.tia/graph.json']
      : [
          `${runner}/graph.json`,
          `.tia/${runner}/graph.json`,
      ]),
  ]
  const allowedPaths = new Set(paths)
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, {
      filter: (entry) =>
        allowedPaths.has(entry.name) &&
        entry.originalSize <= MAX_GRAPH_BYTES,
    })
  } catch {
    return null
  }

  for (const path of paths) {
    const bytes = entries[path]
    if (bytes === undefined || bytes.byteLength > MAX_GRAPH_BYTES) {
      continue
    }

    const graph = parseGraph(strFromU8(bytes))
    if (graph !== null) {
      return graph
    }
  }

  return null
}

export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    return null
  }

  const reader = response.body?.getReader()
  if (reader === undefined) {
    return null
  }

  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }

      length += chunk.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
  } catch {
    return null
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function artifactList(value: unknown): GitHubArtifact[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('artifacts' in value) ||
    !Array.isArray((value as GitHubArtifactList).artifacts)
  ) {
    return []
  }

  return (value as GitHubArtifactList).artifacts.filter(
    (artifact) =>
      typeof artifact === 'object' &&
      artifact !== null &&
      typeof artifact.id === 'number' &&
      typeof artifact.name === 'string' &&
      typeof artifact.expired === 'boolean' &&
      typeof artifact.archive_download_url === 'string' &&
      typeof artifact.created_at === 'string' &&
      typeof artifact.size_in_bytes === 'number',
  )
}

async function loadGitHubActionsArtifact(
  context: TiaArtifactProviderContext,
  options: NormalizedGitHubActionsOptions,
  request: typeof globalThis.fetch,
): Promise<TiaArtifactCandidate[] | null> {
  const repository = repositoryParts(options.repository)
  if (repository === null) {
    return null
  }

  const [owner, name] = repository
  const token = process.env[options.tokenEnv]
  const apiUrl = options.apiUrl.replace(/\/+$/, '')
  const encodedName = encodeURIComponent(options.artifactName)
  const patternedName = picomatch.scan(options.artifactName).isGlob
  const listUrl =
    options.runId === null
      ? `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/artifacts?${patternedName ? '' : `name=${encodedName}&`}per_page=100`
      : `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${encodeURIComponent(options.runId)}/artifacts?${patternedName ? '' : `name=${encodedName}&`}per_page=100&direction=desc`

  const response = await request(listUrl, {
    headers: headers(token),
    redirect: 'follow',
  })
  if (!response.ok) {
    return null
  }

  const currentRun = process.env.GITHUB_RUN_ID
  const matchesArtifact = picomatch(options.artifactName)
  const artifacts = artifactList(await response.json())
    .filter(
      (artifact) =>
        matchesArtifact(artifact.name) &&
        !artifact.expired &&
        artifact.size_in_bytes <= MAX_ARCHIVE_BYTES &&
        (options.branch === null ||
          artifact.workflow_run?.head_branch === options.branch) &&
        (currentRun === undefined ||
          String(artifact.workflow_run?.id ?? '') !== currentRun),
    )
    .sort((left, right) =>
      right.created_at.localeCompare(left.created_at),
    )
    .slice(0, options.maxArtifacts)

  const candidates: TiaArtifactCandidate[] = []
  for (const artifact of artifacts) {
    const download = await request(artifact.archive_download_url, {
      headers: headers(token),
      redirect: 'follow',
    })
    if (!download.ok) {
      continue
    }

    const archive = await readBoundedResponse(
      download,
      MAX_ARCHIVE_BYTES,
    )
    if (archive === null) {
      continue
    }

    const graph = archiveGraph(
      archive,
      context.runner,
    )
    if (
      graph === null ||
      graph.fingerprint !== context.fingerprint
    ) {
      continue
    }

    candidates.push({
      graph,
      ...(artifact.workflow_run?.id === undefined
        ? {}
        : { group: artifact.workflow_run.id }),
      id: artifact.id,
    })
  }

  return candidates.length === 0 ? null : candidates
}

export function createGitHubActionsArtifactProvider(
  source: TiaGitHubActionsOptions,
  request: typeof globalThis.fetch = globalThis.fetch,
): TiaArtifactProvider {
  const options = normalizedOptions(source)
  return {
    name: 'GitHub Actions',
    load: (context) =>
      loadGitHubActionsArtifact(context, options, request),
  }
}
