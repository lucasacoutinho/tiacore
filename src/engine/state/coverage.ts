import type { FileCoverageData } from 'istanbul-lib-coverage'

import {
  COVERAGE_FAMILIES,
  type CoverageFamily,
  type TiaCoverageHits,
  type TiaCoverageRecord,
  type TiaCoverageTemplate,
  type TiaRuntimeGraph,
} from '../../core/runtime.ts'
import { hashBytes } from '../baseline/fingerprint.ts'

// Graph-side coverage: content-addressed static maps plus the counters each
// test advanced. These loops run per file and per counter, so they stay plain.

type CoverageRecords = Pick<TiaRuntimeGraph, CoverageFamily>

function zeros(counters: Record<string, number>): Record<string, number> {
  const zeroed: Record<string, number> = {}
  for (const key of Object.keys(counters)) zeroed[key] = 0
  return zeroed
}

/** A file's static maps with zeroed counters in canonical key order. */
export function coverageTemplate(
  file: Omit<FileCoverageData, 'path'>,
): TiaCoverageTemplate {
  const b: Record<string, number[]> = {}
  for (const [key, counts] of Object.entries(file.b)) {
    b[key] = counts.map(() => 0)
  }
  return {
    b,
    branchMap: file.branchMap,
    f: zeros(file.f),
    fnMap: file.fnMap,
    s: zeros(file.s),
    statementMap: file.statementMap,
  }
}

/** Content digest that names a template in `TiaRuntimeGraph.coverageMaps`. */
export function coverageMapId(template: TiaCoverageTemplate): string {
  return hashBytes(JSON.stringify(template))
}

/** Rebuilds the dense Istanbul file coverage a record describes. */
export function expandCoverageHits(
  template: TiaCoverageTemplate,
  path: string,
  hits: Omit<TiaCoverageHits, 'map'>,
): FileCoverageData {
  const b: Record<string, number[]> = {}
  for (const [key, counts] of Object.entries(template.b)) b[key] = [...counts]
  return {
    b: Object.assign(b, hits.b),
    branchMap: template.branchMap,
    f: { ...template.f, ...hits.f },
    fnMap: template.fnMap,
    path,
    s: { ...template.s, ...hits.s },
    statementMap: template.statementMap,
  }
}

/** Splits dense Istanbul file coverage into a template and advanced counters. */
export function compactFileCoverage(file: FileCoverageData): {
  hits: Omit<TiaCoverageHits, 'map'>
  template: TiaCoverageTemplate
} {
  const hits: Omit<TiaCoverageHits, 'map'> = { b: {}, f: {}, s: {} }
  for (const [key, count] of Object.entries(file.s)) {
    if (count > 0) hits.s[key] = count
  }
  for (const [key, count] of Object.entries(file.f)) {
    if (count > 0) hits.f[key] = count
  }
  for (const [key, counts] of Object.entries(file.b)) {
    if (counts.some((count) => count > 0)) hits.b[key] = [...counts]
  }
  return { hits, template: coverageTemplate(file) }
}

export function coverageRecords(graph: CoverageRecords): TiaCoverageRecord[] {
  return COVERAGE_FAMILIES.flatMap((family) => Object.values(graph[family]))
}

/** The map digests that the graph's coverage records name. */
export function referencedCoverageMaps(graph: CoverageRecords): Set<string> {
  const referenced = new Set<string>()
  for (const record of coverageRecords(graph)) {
    for (const hits of Object.values(record)) referenced.add(hits.map)
  }
  return referenced
}

/** Drops maps that no coverage record names, in place. */
export function pruneCoverageMaps(graph: TiaRuntimeGraph): void {
  const referenced = referencedCoverageMaps(graph)
  for (const id of Object.keys(graph.coverageMaps)) {
    if (!referenced.has(id)) delete graph.coverageMaps[id]
  }
}

/**
 * Deep-copies a graph's mutable records. Coverage maps are immutable,
 * content-addressed values, so the copy shares them and copies only the table.
 */
export function cloneGraph(graph: TiaRuntimeGraph): TiaRuntimeGraph {
  return {
    ...structuredClone({ ...graph, coverageMaps: {} }),
    coverageMaps: { ...graph.coverageMaps },
  }
}
