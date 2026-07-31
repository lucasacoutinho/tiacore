import picomatch from 'picomatch'

import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  readArtifactArchive,
  readBoundedResponse,
} from './archive.js'
import type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaArtifactProviderContext,
  TiaGitHubActionsOptions,
} from './types.js'

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
        artifact.size_in_bytes <= MAX_ARTIFACT_ARCHIVE_BYTES &&
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
      MAX_ARTIFACT_ARCHIVE_BYTES,
    )
    if (archive === null) {
      continue
    }

    const value = readArtifactArchive(
      archive,
      context.runner,
    )
    if (
      value === null ||
      value.graph.fingerprint !== context.fingerprint
    ) {
      continue
    }

    candidates.push({
      ...(value.attestation === undefined
        ? {}
        : { attestation: value.attestation }),
      graph: value.graph,
      graphSha256: value.graphSha256,
      ...(artifact.workflow_run?.id === undefined
        ? {}
        : { group: artifact.workflow_run.id }),
      id: artifact.id,
    })
  }

  return candidates.length === 0 ? null : candidates
}

export { archiveGraph, readBoundedResponse } from './archive.js'

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
