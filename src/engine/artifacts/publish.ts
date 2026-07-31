import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import { strToU8, zipSync } from 'fflate'

import { readGraph } from '../state/store.js'
import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  MAX_ARTIFACT_GRAPH_BYTES,
} from './archive.js'
import type {
  TiaArtifactManifestV1,
  TiaArtifactPublishReceipt,
  TiaArtifactPublisherOptions,
  TiaArtifactSink,
  TiaArtifactSinkInput,
  TiaFilesystemArtifactSinkOptions,
} from './types.js'

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeRunner(value: string): boolean {
  return (
    value !== '' &&
    !value.includes('..') &&
    !value.includes('\\') &&
    !value.startsWith('/')
  )
}

function artifactKey(sha256: string): string {
  return `tiacore-${sha256.slice(0, 24)}.zip`
}

function urlFor(
  key: string,
  baseUrl: string | undefined,
): string {
  if (baseUrl === undefined) return `./${key}`
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(key, normalized).toString()
}

export function createFilesystemArtifactSink(
  options: TiaFilesystemArtifactSinkOptions = {},
  root = process.cwd(),
): TiaArtifactSink {
  const directory = resolve(root, options.directory ?? '.tia-artifacts')
  return {
    name: 'filesystem artifact sink',
    async put(input: TiaArtifactSinkInput) {
      const target = resolve(directory, input.key)
      const path = relative(directory, target)
      if (path.startsWith('..') || path === '') {
        throw new Error('TIA artifact sink key escapes its directory')
      }
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, input.body)
      await rename(temporary, target)
      return { url: urlFor(input.key, options.baseUrl) }
    },
  }
}

export class TiaArtifactPublisher {
  private readonly options: TiaArtifactPublisherOptions

  constructor(options: TiaArtifactPublisherOptions) {
    if (String(options.artifactId).trim() === '') {
      throw new Error('TIA artifact id cannot be empty')
    }
    if (options.runId.trim() === '') {
      throw new Error('TIA artifact run id cannot be empty')
    }
    if (options.runner !== undefined && !safeRunner(options.runner)) {
      throw new Error('TIA artifact runner must be a safe relative path')
    }
    this.options = options
  }

  publish(): Promise<TiaArtifactPublishReceipt> {
    return this.write(false)
  }

  promote(): Promise<TiaArtifactPublishReceipt> {
    return this.write(true)
  }

  private async write(
    promoted: boolean,
  ): Promise<TiaArtifactPublishReceipt> {
    const root = resolve(this.options.root ?? process.cwd())
    const cacheDir = resolve(root, this.options.cacheDir ?? '.tia')
    const graph = readGraph(cacheDir)
    if (graph === null) {
      throw new Error(`no valid TIA graph exists in ${cacheDir}`)
    }
    if (!graph.complete && graph.partition === undefined) {
      throw new Error('TIA refuses to publish an incomplete non-partition graph')
    }
    if (
      promoted &&
      (!graph.complete || graph.partition !== undefined)
    ) {
      throw new Error('TIA refuses to promote a partial graph')
    }
    if (
      promoted &&
      this.options.requireCoverage === true &&
      !graph.coverageComplete
    ) {
      throw new Error('TIA refuses to promote a graph without complete coverage')
    }
    if (graph.baseline.sha === '') {
      throw new Error('TIA refuses to publish a graph without baseline lineage')
    }

    const serialized = `${JSON.stringify(graph)}\n`
    const graphBytes = strToU8(serialized)
    if (graphBytes.byteLength > MAX_ARTIFACT_GRAPH_BYTES) {
      throw new Error('TIA graph exceeds the artifact graph limit')
    }
    const entries: Record<string, Uint8Array> = {
      'graph.json': graphBytes,
    }
    if (this.options.runner !== undefined) {
      entries[`${this.options.runner}/graph.json`] = graphBytes
    }
    const archive = zipSync(entries, { level: 9 })
    if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
      throw new Error('TIA graph archive exceeds the artifact archive limit')
    }

    const sha256 = digest(archive)
    const sink = this.options.sink ?? createFilesystemArtifactSink(
      this.options.filesystem,
      root,
    )
    const artifact = await sink.put({
      body: archive,
      contentType: 'application/zip',
      key: artifactKey(sha256),
      sha256,
    })
    const producedAt = new Date().toISOString()
    const artifactId = artifact.id ?? this.options.artifactId
    const manifest: TiaArtifactManifestV1 = {
      artifacts: [{
        fingerprint: graph.fingerprint,
        ...(this.options.group === undefined
          ? {}
          : { group: this.options.group }),
        id: artifactId,
        lineage: {
          baseline: {
            sha: graph.baseline.sha,
            ...(graph.baseline.source === undefined
              ? {}
              : { source: graph.baseline.source }),
          },
          parents: [...new Set(this.options.parents ?? [])],
          producedAt,
          ...(this.options.producer === undefined
            ? {}
            : { producer: this.options.producer }),
          runId: this.options.runId,
        },
        promoted,
        ...(this.options.runner === undefined
          ? {}
          : { runner: this.options.runner }),
        sha256,
        size: archive.byteLength,
        url: artifact.url,
      }],
      generatedAt: producedAt,
      version: 1,
    }
    const manifestBytes = strToU8(
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    const manifestResult = await sink.put({
      body: manifestBytes,
      contentType: 'application/json',
      key: 'manifest.json',
      sha256: digest(manifestBytes),
    })

    return {
      artifactId,
      artifactUrl: artifact.url,
      baselineSha: graph.baseline.sha,
      bytes: archive.byteLength,
      fingerprint: graph.fingerprint,
      manifestUrl: manifestResult.url,
      promoted,
      sha256,
      sink: sink.name,
    }
  }
}

export function tia(
  options: TiaArtifactPublisherOptions,
): TiaArtifactPublisher {
  return new TiaArtifactPublisher(options)
}
