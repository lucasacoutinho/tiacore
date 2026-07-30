import {
  archiveGraph,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  readBoundedResponse,
} from './archive.js'
import type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
  TiaArtifactProviderContext,
  TiaHttpManifestOptions,
} from '../shared/types.js'

const MAX_MANIFEST_BYTES = 1024 * 1024

interface ManifestArtifact {
  fingerprint?: string
  group?: number | string
  id: number | string
  runner?: string
  url: string
}

function manifestArtifacts(value: unknown): ManifestArtifact[] {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { artifacts?: unknown }).artifacts)
  ) {
    return []
  }

  return (value as { artifacts: unknown[] }).artifacts.filter(
    (artifact): artifact is ManifestArtifact => {
      if (artifact === null || typeof artifact !== 'object') return false
      const candidate = artifact as Partial<ManifestArtifact>
      return (
        (typeof candidate.id === 'number' ||
          typeof candidate.id === 'string') &&
        typeof candidate.url === 'string' &&
        candidate.url.length <= 8_192 &&
        (candidate.group === undefined ||
          typeof candidate.group === 'number' ||
          typeof candidate.group === 'string') &&
        (candidate.fingerprint === undefined ||
          typeof candidate.fingerprint === 'string') &&
        (candidate.runner === undefined ||
          typeof candidate.runner === 'string')
      )
    },
  )
}

function authorizationHeaders(
  token: string | undefined,
  scheme: string,
): Record<string, string> {
  return token === undefined || token === ''
    ? {}
    : { Authorization: `${scheme} ${token}` }
}

async function loadHttpManifest(
  context: TiaArtifactProviderContext,
  options: TiaHttpManifestOptions,
  request: typeof globalThis.fetch,
): Promise<TiaArtifactCandidate[] | null> {
  const manifestUrl = new URL(options.url)
  if (!['http:', 'https:'].includes(manifestUrl.protocol)) {
    return null
  }
  const token =
    options.tokenEnv === undefined
      ? undefined
      : process.env[options.tokenEnv]
  const headers = authorizationHeaders(
    token,
    options.authorizationScheme ?? 'Bearer',
  )
  const response = await request(manifestUrl, {
    headers,
    redirect: 'follow',
  })
  if (!response.ok) return null
  const bytes = await readBoundedResponse(response, MAX_MANIFEST_BYTES)
  if (bytes === null) return null

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }

  const artifacts = manifestArtifacts(value)
    .filter(
      (artifact) =>
        (artifact.fingerprint === undefined ||
          artifact.fingerprint === context.fingerprint) &&
        (artifact.runner === undefined ||
          artifact.runner === context.runner),
    )
    .slice(0, Math.max(1, Math.min(100, options.maxArtifacts ?? 20)))
  const candidates: TiaArtifactCandidate[] = []
  for (const artifact of artifacts) {
    let artifactUrl: URL
    try {
      artifactUrl = new URL(artifact.url, manifestUrl)
    } catch {
      continue
    }
    if (!['http:', 'https:'].includes(artifactUrl.protocol)) continue
    const download = await request(artifactUrl, {
      headers:
        artifactUrl.origin === manifestUrl.origin ? headers : {},
      redirect: 'follow',
    })
    if (!download.ok) continue
    const archive = await readBoundedResponse(
      download,
      MAX_ARTIFACT_ARCHIVE_BYTES,
    )
    if (archive === null) continue
    const graph = archiveGraph(archive, context.runner)
    if (graph?.fingerprint !== context.fingerprint) continue
    candidates.push({
      graph,
      ...(artifact.group === undefined
        ? {}
        : { group: artifact.group }),
      id: artifact.id,
    })
  }
  return candidates.length === 0 ? null : candidates
}

export function createHttpManifestArtifactProvider(
  options: TiaHttpManifestOptions,
  request: typeof globalThis.fetch = globalThis.fetch,
): TiaArtifactProvider {
  return {
    name: options.name ?? 'HTTP artifact manifest',
    load: (context) => loadHttpManifest(context, options, request),
  }
}
