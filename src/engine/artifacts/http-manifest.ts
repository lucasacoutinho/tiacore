import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'

import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_MANIFEST_BYTES,
  type TiaArtifactCandidate,
  type TiaArtifactProvider,
  type TiaArtifactProviderContext,
  type TiaHttpManifestOptions,
} from '../../core/artifacts.ts'
import { runPromise } from '../../host/runtime.ts'
import { hashBytes } from '../baseline/fingerprint.ts'
import { readArtifactArchive } from './archive.ts'
import { type Fetch, getBytes, getJson } from './http.ts'
import { readManifest } from './schema.ts'

function authorizationHeaders(
  token: Redacted.Redacted<string> | undefined,
  scheme: string,
): Record<string, string> {
  const secret = token === undefined ? '' : Redacted.value(token)
  return secret === '' ? {} : { Authorization: `${scheme} ${secret}` }
}

const isWeb = (url: URL): boolean => ['http:', 'https:'].includes(url.protocol)

export const loadHttpManifest = Effect.fnUntraced(function* (
  context: TiaArtifactProviderContext,
  options: TiaHttpManifestOptions,
  request: Fetch,
) {
  if (!URL.canParse(options.url)) return null
  const manifestUrl = new URL(options.url)
  if (!isWeb(manifestUrl)) return null

  const raw =
    options.tokenEnv === undefined ? undefined : process.env[options.tokenEnv]
  const headers = authorizationHeaders(
    raw === undefined ? undefined : Redacted.make(raw),
    options.authorizationScheme ?? 'Bearer',
  )
  const document = yield* getJson(
    request,
    manifestUrl,
    headers,
    MAX_MANIFEST_BYTES,
  )
  const manifest = readManifest(document)
  if (manifest === null) return null

  const artifacts = manifest.artifacts
    .filter(
      (artifact) =>
        (artifact.fingerprint === undefined ||
          artifact.fingerprint === context.fingerprint) &&
        (artifact.runner === undefined || artifact.runner === context.runner) &&
        (options.promotedOnly !== true || artifact.promoted === true),
    )
    .slice(0, Math.max(1, Math.min(100, options.maxArtifacts ?? 20)))
  const candidates: TiaArtifactCandidate[] = []
  for (const artifact of artifacts) {
    const artifactUrl = URL.canParse(artifact.url, manifestUrl.href)
      ? new URL(artifact.url, manifestUrl.href)
      : null
    if (artifactUrl === null || !isWeb(artifactUrl)) continue
    // The manifest's credential goes only to the host that served the
    // manifest, never to a signed storage URL elsewhere.
    const archive = yield* getBytes(
      request,
      artifactUrl,
      artifactUrl.origin === manifestUrl.origin ? headers : {},
      MAX_ARTIFACT_ARCHIVE_BYTES,
    )
    if (archive === null) continue
    if (
      (artifact.size !== undefined && archive.byteLength !== artifact.size) ||
      (artifact.sha256 !== undefined && hashBytes(archive) !== artifact.sha256)
    ) {
      continue
    }
    const value = readArtifactArchive(archive, context.runner)
    if (value?.graph.fingerprint !== context.fingerprint) continue
    candidates.push({
      ...(value.attestation === undefined
        ? {}
        : { attestation: value.attestation }),
      graph: value.graph,
      graphSha256: value.graphSha256,
      ...(artifact.group === undefined ? {} : { group: artifact.group }),
      id: artifact.id,
    })
  }
  return candidates.length === 0 ? null : candidates
})

export function createHttpManifestArtifactProvider(
  options: TiaHttpManifestOptions,
  request: Fetch = globalThis.fetch,
): TiaArtifactProvider {
  return {
    name: options.name ?? 'HTTP artifact manifest',
    load: (context) => runPromise(loadHttpManifest(context, options, request)),
  }
}
