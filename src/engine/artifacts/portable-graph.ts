import type { FileCoverageData } from 'istanbul-lib-coverage'

import { isRecord } from '../../core/record.ts'
import {
  COVERAGE_FAMILIES,
  GRAPH_SCHEMA_VERSION,
  isCoverageFamily,
  type TiaCoverageRecord,
  type TiaCoverageTemplate,
  type TiaRuntimeGraph,
} from '../../core/runtime.ts'
import { parseRuntimeGraph } from '../../wire/runtime-graph.ts'
import {
  compactFileCoverage,
  coverageMapId,
  expandCoverageHits,
} from '../state/coverage.ts'

// Artifact `graph.json` keeps the schema-3 graph layout, in which every
// coverage record carries complete Istanbul file coverage. The runtime graph
// stores each map once and converts at this boundary. These loops run per file
// and per counter, so they stay plain.

export const PORTABLE_GRAPH_SCHEMA_VERSION = 3

function isCounter(count: unknown): boolean {
  return Number.isSafeInteger(count)
}

function isFileCoverage(value: unknown): value is FileCoverageData {
  return (
    isRecord(value) &&
    isRecord(value['statementMap']) &&
    isRecord(value['fnMap']) &&
    isRecord(value['branchMap']) &&
    isRecord(value['s']) &&
    Object.values(value['s']).every(isCounter) &&
    isRecord(value['f']) &&
    Object.values(value['f']).every(isCounter) &&
    isRecord(value['b']) &&
    Object.values(value['b']).every(
      (counts) => Array.isArray(counts) && counts.every(isCounter),
    )
  )
}

function compactRecords(
  records: unknown,
  maps: Record<string, TiaCoverageTemplate>,
): Record<string, TiaCoverageRecord> | null {
  if (!isRecord(records)) return null
  const compacted: Record<string, TiaCoverageRecord> = {}
  for (const [key, coverage] of Object.entries(records)) {
    // Assigning `__proto__` would replace the record's prototype.
    if (key === '__proto__' || !isRecord(coverage)) return null
    const record: TiaCoverageRecord = {}
    for (const [path, file] of Object.entries(coverage)) {
      if (path === '__proto__' || !isFileCoverage(file)) return null
      const { hits, template } = compactFileCoverage(file)
      const map = coverageMapId(template)
      maps[map] ??= template
      record[path] = { ...hits, map }
    }
    compacted[key] = record
  }
  return compacted
}

/**
 * Parses an artifact graph from JSON text or a value. A schema-3 portable
 * graph is compacted into the runtime layout; any other value must already be
 * a runtime graph of the current schema. Null when it is neither.
 */
export function parseArtifactGraph(source: unknown): TiaRuntimeGraph | null {
  let value: unknown
  try {
    value = typeof source === 'string' ? JSON.parse(source) : source
  } catch {
    return null
  }
  if (!isRecord(value) || value['schema'] !== PORTABLE_GRAPH_SCHEMA_VERSION) {
    return parseRuntimeGraph(value)
  }

  const coverageMaps: Record<string, TiaCoverageTemplate> = {}
  const compacted: Record<string, Record<string, TiaCoverageRecord>> = {}
  for (const family of COVERAGE_FAMILIES) {
    const records = compactRecords(value[family], coverageMaps)
    if (records === null) return null
    compacted[family] = records
  }
  return parseRuntimeGraph({
    // A 1.x graph records no collection files; none is what it means.
    collectionFiles: {},
    ...value,
    ...compacted,
    coverageMaps,
    schema: GRAPH_SCHEMA_VERSION,
  })
}

/**
 * Serializes a runtime graph as portable schema-3 `graph.json` bytes. The
 * output is assembled piece by piece and rejected as soon as it passes
 * `limit`, so an oversized graph is never fully expanded.
 */
export function portableGraphBytes(
  graph: TiaRuntimeGraph,
  limit: number,
): Buffer {
  const pieces: Buffer[] = []
  let bytes = 0
  const append = (text: string): void => {
    const piece = Buffer.from(text)
    bytes += piece.byteLength
    if (bytes > limit) {
      throw new Error('TIA graph exceeds the artifact graph limit')
    }
    pieces.push(piece)
  }

  const { coverageMaps, ...portable } = graph
  const entries = Object.entries({
    ...portable,
    schema: PORTABLE_GRAPH_SCHEMA_VERSION,
  }).filter(([, value]) => value !== undefined)
  append('{')
  entries.forEach(([key, value], index) => {
    append(`${index === 0 ? '' : ','}${JSON.stringify(key)}:`)
    if (!isCoverageFamily(key)) {
      append(JSON.stringify(value))
      return
    }
    append('{')
    Object.entries(graph[key]).forEach(([id, record], recordIndex) => {
      const expanded: Record<string, FileCoverageData> = {}
      for (const [path, hits] of Object.entries(record)) {
        const template = coverageMaps[hits.map]
        if (template === undefined) {
          throw new Error(`TIA graph names a missing coverage map: ${path}`)
        }
        expanded[path] = expandCoverageHits(template, path, hits)
      }
      append(
        `${recordIndex === 0 ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(expanded)}`,
      )
    })
    append('}')
  })
  append('}\n')
  return Buffer.concat(pieces)
}
