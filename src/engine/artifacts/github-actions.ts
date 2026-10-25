import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'
import * as Redacted from 'effect/Redacted'
import picomatch from 'picomatch'

import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  type TiaArtifactCandidate,
  type TiaArtifactProvider,
  type TiaArtifactProviderContext,
  type TiaGitHubActionsOptions,
} from '../../core/artifacts.ts'
import { byCodeUnit } from '../../core/canonical.ts'
import { runPromise } from '../../host/runtime.ts'
import { readArtifactArchive } from './archive.ts'
import { type Fetch, getBytes, getJson, MAX_LISTING_BYTES } from './http.ts'

interface GitHubArtifact {
  archive_download_url: string
  created_at: string
  expired: boolean
  id: number
  name: string
  size_in_bytes: number
  workflow_run?: { head_branch?: string; id?: number }
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
    maxArtifacts: Math.max(1, Math.min(100, options.maxArtifacts ?? 20)),
    repository: options.repository ?? process.env['GITHUB_REPOSITORY'] ?? null,
    runId: options.runId === undefined ? null : String(options.runId),
    tokenEnv: options.tokenEnv ?? 'GITHUB_TOKEN',
  }
}

function repositoryParts(repository: string | null): [string, string] | null {
  if (repository === null) return null
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository)
  return match === null ? null : [match[1]!, match[2]!]
}

function headers(
  token: Redacted.Redacted<string> | undefined,
): Record<string, string> {
  const secret = token === undefined ? '' : Redacted.value(token)
  return {
    Accept: 'application/vnd.github+json',
    ...(secret === '' ? {} : { Authorization: `Bearer ${secret}` }),
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function isGitHubArtifact(artifact: unknown): artifact is GitHubArtifact {
  return (
    Predicate.isObject(artifact) &&
    typeof artifact['id'] === 'number' &&
    typeof artifact['name'] === 'string' &&
    typeof artifact['expired'] === 'boolean' &&
    typeof artifact['archive_download_url'] === 'string' &&
    typeof artifact['created_at'] === 'string' &&
    typeof artifact['size_in_bytes'] === 'number'
  )
}

function artifactList(value: unknown): GitHubArtifact[] {
  if (!Predicate.isObject(value) || !Array.isArray(value['artifacts'])) {
    return []
  }
  return value['artifacts'].filter(isGitHubArtifact)
}

export const loadGitHubActionsArtifacts = Effect.fnUntraced(function* (
  context: TiaArtifactProviderContext,
  options: NormalizedGitHubActionsOptions,
  request: Fetch,
) {
  const repository = repositoryParts(options.repository)
  if (repository === null) return null

  const [owner, name] = repository
  const raw = process.env[options.tokenEnv]
  const token = raw === undefined ? undefined : Redacted.make(raw)
  const apiUrl = options.apiUrl.replace(/\/+$/u, '')
  const encodedName = encodeURIComponent(options.artifactName)
  const patternedName = picomatch.scan(options.artifactName).isGlob
  const nameQuery = patternedName ? '' : `name=${encodedName}&`
  const repo = `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions`
  const listUrl =
    options.runId === null
      ? `${repo}/artifacts?${nameQuery}per_page=100`
      : `${repo}/runs/${encodeURIComponent(options.runId)}/artifacts?${nameQuery}per_page=100&direction=desc`

  const listing = yield* getJson(
    request,
    listUrl,
    headers(token),
    MAX_LISTING_BYTES,
  )
  if (listing === null) return null

  const currentRun = process.env['GITHUB_RUN_ID']
  const matchesArtifact = picomatch(options.artifactName)
  const artifacts = artifactList(listing)
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
    .sort((left, right) => byCodeUnit(right.created_at, left.created_at))
    .slice(0, options.maxArtifacts)

  const candidates: TiaArtifactCandidate[] = []
  for (const artifact of artifacts) {
    const archive = yield* getBytes(
      request,
      artifact.archive_download_url,
      headers(token),
      MAX_ARTIFACT_ARCHIVE_BYTES,
    )
    if (archive === null) continue

    const value = readArtifactArchive(archive, context.runner)
    if (value === null || value.graph.fingerprint !== context.fingerprint) {
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
})

export function createGitHubActionsArtifactProvider(
  source: TiaGitHubActionsOptions,
  request: Fetch = globalThis.fetch,
): TiaArtifactProvider {
  const options = normalizedOptions(source)
  return {
    name: 'GitHub Actions',
    load: (context) =>
      runPromise(loadGitHubActionsArtifacts(context, options, request)),
  }
}
