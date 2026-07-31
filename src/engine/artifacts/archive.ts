import { createHash } from 'node:crypto'

import { strFromU8, unzipSync } from 'fflate'

import { parseGraph } from '../state/store.js'
import type { TiaRuntimeGraph } from '../types.js'
import { parseArtifactAttestation } from './trust.js'
import type { TiaArtifactAttestationV1 } from './types.js'

export const MAX_ARTIFACT_ARCHIVE_BYTES = 25 * 1024 * 1024
export const MAX_ARTIFACT_GRAPH_BYTES = 20 * 1024 * 1024

export interface TiaArtifactArchive {
  attestation?: TiaArtifactAttestationV1
  graph: TiaRuntimeGraph
  graphSha256: string
}

const NESTED_ARCHIVE_PATTERN = /(?:^|\/)tiacore-[a-f0-9]{24}\.zip$/

function readArchive(
  archive: Uint8Array,
  runner: string | undefined,
  depth: number,
): TiaArtifactArchive | null {
  if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
    return null
  }

  const graphPaths = [
    ...(runner === undefined
      ? ['graph.json', '.tia/graph.json']
      : [
          `${runner}/graph.json`,
          `.tia/${runner}/graph.json`,
        ]),
  ]
  const attestationPaths = [
    ...(runner === undefined
      ? ['attestation.json', '.tia/attestation.json']
      : [
          `${runner}/attestation.json`,
          `.tia/${runner}/attestation.json`,
          'attestation.json',
        ]),
  ]
  const allowedPaths = new Set([...graphPaths, ...attestationPaths])
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, {
      filter: (entry) =>
        (
          allowedPaths.has(entry.name) ||
          (depth === 0 && NESTED_ARCHIVE_PATTERN.test(entry.name))
        ) &&
        entry.originalSize <= MAX_ARTIFACT_GRAPH_BYTES,
    })
  } catch {
    return null
  }

  for (const path of graphPaths) {
    const bytes = entries[path]
    if (
      bytes === undefined ||
      bytes.byteLength > MAX_ARTIFACT_GRAPH_BYTES
    ) {
      continue
    }

    const graph = parseGraph(strFromU8(bytes))
    if (graph !== null) {
      let attestation: TiaArtifactAttestationV1 | undefined
      for (const attestationPath of attestationPaths) {
        const value = entries[attestationPath]
        if (value === undefined) continue
        try {
          const parsed = parseArtifactAttestation(
            JSON.parse(strFromU8(value)) as unknown,
          )
          if (parsed !== null) {
            attestation = parsed
            break
          }
        } catch {
          // A malformed attestation is handled by the trust policy.
        }
      }
      return {
        ...(attestation === undefined ? {} : { attestation }),
        graph,
        graphSha256: createHash('sha256').update(bytes).digest('hex'),
      }
    }
  }

  if (depth === 0) {
    for (const [path, bytes] of Object.entries(entries).sort()) {
      if (!NESTED_ARCHIVE_PATTERN.test(path)) continue
      const nested = readArchive(bytes, runner, depth + 1)
      if (nested !== null) return nested
    }
  }

  return null
}

export function readArtifactArchive(
  archive: Uint8Array,
  runner: string | undefined,
): TiaArtifactArchive | null {
  return readArchive(archive, runner, 0)
}

export function archiveGraph(
  archive: Uint8Array,
  runner: string | undefined,
): TiaRuntimeGraph | null {
  return readArtifactArchive(archive, runner)?.graph ?? null
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
