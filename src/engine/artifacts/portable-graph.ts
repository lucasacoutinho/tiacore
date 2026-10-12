import type { FileCoverageData } from 'istanbul-lib-coverage'

import { GRAPH_SCHEMA_VERSION } from '../../shared/constants.js'
import {
  compactFileCoverage,
  coverageMapId,
  expandCoverageHits,
} from '../state/coverage.js'
import { parseGraph } from '../state/store.js'
import type {
  TiaCoverageRecord,
  TiaCoverageTemplate,
} from '../../integrations/coverage/types.js'
import type { TiaRuntimeGraph } from '../types.js'

/**
 * Artifact `graph.json` keeps the schema-3 graph layout, in which every
 * coverage record carries complete Istanbul file coverage. The runtime graph
 * stores maps once and converts at this boundary.
 */
export const PORTABLE_GRAPH_SCHEMA_VERSION = 3

const COVERAGE_DOMAINS = new Set(['collectionCoverage', 'testCoverage'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileCoverage(value: unknown): value is FileCoverageData {
  return (
    isRecord(value) &&
    isRecord(value.statementMap) &&
    isRecord(value.fnMap) &&
    isRecord(value.branchMap) &&
    isRecord(value.s) &&
    Object.values(value.s).every((count) => Number.isSafeInteger(count)) &&
    isRecord(value.f) &&
    Object.values(value.f).every((count) => Number.isSafeInteger(count)) &&
    isRecord(value.b) &&
    Object.values(value.b).every(
      (counts) =>
        Array.isArray(counts) &&
        counts.every((count) => Number.isSafeInteger(count)),
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
    if (!isRecord(coverage)) return null
    const record: TiaCoverageRecord = {}
    for (const [path, file] of Object.entries(coverage)) {
      if (!isFileCoverage(file)) return null
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
 * Parses an artifact graph. Schema-3 portable graphs are compacted into the
 * runtime layout; runtime graphs from a local store pass through validation.
 */
export function parseArtifactGraph(
  source: string | unknown,
): TiaRuntimeGraph | null {
  let value: unknown
  try {
    value = typeof source === 'string' ? JSON.parse(source) : source
  } catch {
    return null
  }
  if (!isRecord(value) || value.schema !== PORTABLE_GRAPH_SCHEMA_VERSION) {
    return parseGraph(value)
  }

  const coverageMaps: Record<string, TiaCoverageTemplate> = {}
  const collectionCoverage = compactRecords(
    value.collectionCoverage,
    coverageMaps,
  )
  const testCoverage = compactRecords(value.testCoverage, coverageMaps)
  if (collectionCoverage === null || testCoverage === null) return null
  return parseGraph({
    ...value,
    collectionCoverage,
    coverageMaps,
    schema: GRAPH_SCHEMA_VERSION,
    testCoverage,
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
    if (!COVERAGE_DOMAINS.has(key)) {
      append(JSON.stringify(value))
      return
    }
    append('{')
    Object.entries(value as Record<string, TiaCoverageRecord>).forEach(
      ([id, record], recordIndex) => {
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
      },
    )
    append('}')
  })
  append('}\n')
  return Buffer.concat(pieces)
}
