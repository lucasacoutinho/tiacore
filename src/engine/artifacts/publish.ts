import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'

import {
  isArtifactIdentifier,
  isSafeRunner,
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_ARTIFACT_GRAPH_BYTES,
  MAX_ARTIFACT_LIST,
  MAX_ARTIFACT_TEXT,
  TIA_ARTIFACT_MANIFEST_VERSION,
  type TiaArtifactClaimV1,
  type TiaArtifactId,
  type TiaArtifactLineage,
  type TiaArtifactManifestV1,
  type TiaArtifactPublishReceipt,
  type TiaArtifactPublisherOptions,
  type TiaArtifactSigningOptions,
} from '../../core/artifacts.ts'
import { runPromise } from '../../host/runtime.ts'
import { TiaInvalid } from '../../wire/errors.ts'
import { GraphStore } from '../ports.ts'
import { GraphStoreLive } from '../state/graph-store.ts'
import { writeArtifactArchive } from './archive.ts'
import { portableGraphBytes } from './portable-graph.ts'
import { putToDirectory, putToSink } from './sink.ts'
import { createArtifactAttestation } from './trust.ts'

const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60
const MAX_EXPIRY_SECONDS = 365 * 24 * 60 * 60

export { createFilesystemArtifactSink } from './sink.ts'

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function artifactKey(sha256: string): string {
  return `tiacore-${sha256.slice(0, 24)}.zip`
}

const invalid = (message: string) => new TiaInvalid({ message })

/** The first problem with the options a publisher is built from, if any. */
function optionsProblem(
  options: Pick<
    TiaArtifactPublisherOptions,
    'artifactId' | 'group' | 'parents' | 'producer' | 'runId' | 'runner'
  > & { signing: Pick<TiaArtifactSigningOptions, 'expiresInSeconds'> },
): string | null {
  if (String(options.artifactId).trim() === '') {
    return 'TIA artifact id cannot be empty'
  }
  if (!isArtifactIdentifier(options.artifactId)) {
    return 'TIA artifact id must be a safe integer or text of at most 8192 characters'
  }
  if (options.runId.trim() === '') {
    return 'TIA artifact run id cannot be empty'
  }
  if (options.runId.length > MAX_ARTIFACT_TEXT) {
    return 'TIA artifact run id is too long'
  }
  if (options.runner !== undefined && !isSafeRunner(options.runner)) {
    return 'TIA artifact runner must be a safe relative path'
  }
  if (
    options.runner !== undefined &&
    options.runner.length > MAX_ARTIFACT_TEXT
  ) {
    return 'TIA artifact runner is too long'
  }
  const expiresInSeconds =
    options.signing.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS
  if (
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds <= 0 ||
    expiresInSeconds > MAX_EXPIRY_SECONDS
  ) {
    return 'TIA artifact signing expiry must be between 1 second and 1 year'
  }
  const identifiers = [options.group, ...(options.parents ?? [])].filter(
    (value) => value !== undefined,
  )
  if (!identifiers.every(isArtifactIdentifier)) {
    return 'TIA artifact group and parent ids must be safe integers or text of at most 8192 characters'
  }
  if (new Set(options.parents ?? []).size > MAX_ARTIFACT_LIST) {
    return 'TIA artifact lineage names more than 100 parents'
  }
  if (
    options.producer !== undefined &&
    (options.producer === '' || options.producer.length > MAX_ARTIFACT_TEXT)
  ) {
    return 'TIA artifact producer must be between 1 and 8192 characters'
  }
  return null
}

/** Publisher options with the private key held as a redacted value. */
interface PublisherConfig extends Omit<TiaArtifactPublisherOptions, 'signing'> {
  signing: Omit<TiaArtifactSigningOptions, 'privateKey'> & {
    privateKey: Redacted.Redacted<string>
  }
}

function configure(options: TiaArtifactPublisherOptions): PublisherConfig {
  const { signing, ...rest } = options
  return {
    ...rest,
    signing: { ...signing, privateKey: Redacted.make(signing.privateKey) },
  }
}

const publishConfigured = Effect.fn('tia.artifacts.publish')(function* (
  options: PublisherConfig,
  promoted: boolean,
) {
  const problem = optionsProblem(options)
  if (problem !== null) return yield* invalid(problem)

  const root = resolve(options.root ?? process.cwd())
  const cacheDir = resolve(root, options.cacheDir ?? '.tia')
  const { graph } = yield* (yield* GraphStore).read(cacheDir)
  if (graph === null) {
    return yield* invalid(`no valid TIA graph exists in ${cacheDir}`)
  }
  if (!graph.complete && graph.partition === undefined) {
    return yield* invalid(
      'TIA refuses to publish an incomplete non-partition graph',
    )
  }
  if (promoted && (!graph.complete || graph.partition !== undefined)) {
    return yield* invalid('TIA refuses to promote a partial graph')
  }
  if (promoted && options.requireCoverage === true && !graph.coverageComplete) {
    return yield* invalid(
      'TIA refuses to promote a graph without complete coverage',
    )
  }
  if (graph.baseline.sha === '') {
    return yield* invalid(
      'TIA refuses to publish a graph without baseline lineage',
    )
  }

  const graphBytes = yield* Effect.try({
    catch: (error) =>
      invalid(error instanceof Error ? error.message : String(error)),
    try: () => portableGraphBytes(graph, MAX_ARTIFACT_GRAPH_BYTES),
  })
  const issuedMillis = yield* Clock.currentTimeMillis
  const producedAt = new Date(issuedMillis).toISOString()
  const expiresInSeconds =
    options.signing.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS
  const lineage: TiaArtifactLineage = {
    baseline: {
      sha: graph.baseline.sha,
      ...(graph.baseline.source === undefined
        ? {}
        : { source: graph.baseline.source }),
    },
    parents: [...new Set(options.parents ?? [])],
    producedAt,
    ...(options.producer === undefined ? {} : { producer: options.producer }),
    runId: options.runId,
  }
  const claim: TiaArtifactClaimV1 = {
    expiresAt: new Date(issuedMillis + expiresInSeconds * 1_000).toISOString(),
    fingerprint: graph.fingerprint,
    graphSha256: digest(graphBytes),
    issuedAt: producedAt,
    lineage,
    promoted,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  }
  const attestation = yield* Effect.try({
    catch: (error) =>
      invalid(error instanceof Error ? error.message : String(error)),
    try: () =>
      createArtifactAttestation(claim, {
        keyId: options.signing.keyId,
        privateKey: Redacted.value(options.signing.privateKey),
      }),
  })
  const attestationBytes = new TextEncoder().encode(
    `${JSON.stringify(attestation)}\n`,
  )
  const entries: Array<[string, Uint8Array]> = [
    ['attestation.json', attestationBytes],
    ['graph.json', graphBytes],
  ]
  if (options.runner !== undefined) {
    entries.push(
      [`${options.runner}/attestation.json`, attestationBytes],
      [`${options.runner}/graph.json`, graphBytes],
    )
  }
  const archive = writeArtifactArchive(entries)
  if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
    return yield* invalid(
      'TIA graph archive exceeds the artifact archive limit',
    )
  }

  const sha256 = digest(archive)
  const put = (input: Parameters<typeof putToSink>[1]) =>
    options.sink === undefined
      ? putToDirectory(
          resolve(root, options.filesystem?.directory ?? '.tia-artifacts'),
          options.filesystem?.baseUrl,
          input,
        )
      : putToSink(options.sink, input)
  const sinkName = options.sink?.name ?? 'filesystem artifact sink'

  const artifact = yield* put({
    body: archive,
    contentType: 'application/zip',
    key: artifactKey(sha256),
    sha256,
  })
  const artifactId: TiaArtifactId = artifact.id ?? options.artifactId
  if (
    !isArtifactIdentifier(artifactId) ||
    artifact.url.length > MAX_ARTIFACT_TEXT
  ) {
    return yield* invalid('TIA artifact sink returned an invalid id or url')
  }
  const manifest: TiaArtifactManifestV1 = {
    artifacts: [
      {
        fingerprint: graph.fingerprint,
        ...(options.group === undefined ? {} : { group: options.group }),
        id: artifactId,
        lineage,
        promoted,
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        sha256,
        size: archive.byteLength,
        url: artifact.url,
      },
    ],
    generatedAt: producedAt,
    version: TIA_ARTIFACT_MANIFEST_VERSION,
  }
  const manifestBytes = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  const manifestResult = yield* put({
    body: manifestBytes,
    contentType: 'application/json',
    key: 'manifest.json',
    sha256: digest(manifestBytes),
  })

  const receipt: TiaArtifactPublishReceipt = {
    artifactId,
    artifactUrl: artifact.url,
    baselineSha: graph.baseline.sha,
    bytes: archive.byteLength,
    fingerprint: graph.fingerprint,
    keyId: options.signing.keyId,
    manifestUrl: manifestResult.url,
    promoted,
    sha256,
    sink: sinkName,
    trustExpiresAt: claim.expiresAt,
  }
  return receipt
})

/**
 * Publishes (or, with `promoted`, promotes) the graph in the options' cache
 * directory as a signed archive plus manifest.
 */
export const publishGraph = (
  options: TiaArtifactPublisherOptions,
  promoted: boolean,
) => publishConfigured(configure(options), promoted)

export class TiaArtifactPublisher {
  private readonly config: PublisherConfig

  constructor(options: TiaArtifactPublisherOptions) {
    const problem = optionsProblem(options)
    if (problem !== null) throw new Error(problem)
    this.config = configure(options)
  }

  publish(): Promise<TiaArtifactPublishReceipt> {
    return this.write(false)
  }

  promote(): Promise<TiaArtifactPublishReceipt> {
    return this.write(true)
  }

  private write(promoted: boolean): Promise<TiaArtifactPublishReceipt> {
    return runPromise(
      publishConfigured(this.config, promoted).pipe(
        Effect.provide(GraphStoreLive),
      ),
    )
  }
}

export function tia(
  options: TiaArtifactPublisherOptions,
): TiaArtifactPublisher {
  return new TiaArtifactPublisher(options)
}
