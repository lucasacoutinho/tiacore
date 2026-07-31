import { strFromU8, unzipSync } from 'fflate'

import { parseGraph } from '../state/store.js'
import type { TiaRuntimeGraph } from '../types.js'

export const MAX_ARTIFACT_ARCHIVE_BYTES = 25 * 1024 * 1024
export const MAX_ARTIFACT_GRAPH_BYTES = 20 * 1024 * 1024

export function archiveGraph(
  archive: Uint8Array,
  runner: string | undefined,
): TiaRuntimeGraph | null {
  if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
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
        entry.originalSize <= MAX_ARTIFACT_GRAPH_BYTES,
    })
  } catch {
    return null
  }

  for (const path of paths) {
    const bytes = entries[path]
    if (
      bytes === undefined ||
      bytes.byteLength > MAX_ARTIFACT_GRAPH_BYTES
    ) {
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
