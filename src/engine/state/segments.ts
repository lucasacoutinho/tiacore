import { createHash, hash } from 'node:crypto'

import { byCodeUnit } from '../../core/canonical.ts'
import type { TiaRuntimeGraph } from '../../core/runtime.ts'
import { referencedCoverageMaps } from './coverage.ts'

// The segmented runtime-state layout. A graph is a small manifest plus
// content-addressed bucket objects, so no code path ever holds the whole graph
// as one string. Everything here is synchronous and pure; the stores add the
// file system on top.
//
// Store version 3 (graph schema 5) differs from 1.x's version 2 in two ways:
// bucket records are ordered by UTF-16 code unit, and `baseline.workingTree`
// is a segment domain of its own, so a large dirty tree no longer counts
// against the manifest's size limit (ADR 0004 row STATE-LIMIT-02).

export const TIA_RUNTIME_STORE_VERSION = 3 as const
export const TIA_RUNTIME_STORE_BUCKETS = 64
export const MAX_MANIFEST_BYTES = 1024 * 1024
export const MAX_SEGMENT_BYTES = 20 * 1024 * 1024

const STORE_FORMAT = 'tiacore-runtime-state'

export const SEGMENT_DOMAINS = [
  'collectionCoverage',
  'coverageMaps',
  'edges',
  'results',
  'testCoverage',
  'testEdges',
  'workingTree',
] as const

export type SegmentDomain = (typeof SEGMENT_DOMAINS)[number]

export interface SegmentReference {
  readonly bucket: number
  readonly bytes: number
  readonly entries: number
  readonly sha256: string
}

type Metadata = Record<string, unknown>

export interface RuntimeStateManifest {
  readonly format: typeof STORE_FORMAT
  readonly generation: string
  readonly metadata: Metadata
  readonly segments: Readonly<
    Record<SegmentDomain, readonly SegmentReference[]>
  >
  readonly version: typeof TIA_RUNTIME_STORE_VERSION
}

export interface SerializedSegment {
  readonly body: string
  readonly domain: SegmentDomain
  readonly reference: SegmentReference
}

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function bucketFor(key: string): number {
  return hash('sha256', key, 'buffer')[0]! % TIA_RUNTIME_STORE_BUCKETS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const SHA256 = /^[a-f0-9]{64}$/u

function segmentReference(value: unknown): value is SegmentReference {
  return (
    isRecord(value) &&
    Number.isInteger(value.bucket) &&
    (value.bucket as number) >= 0 &&
    (value.bucket as number) < TIA_RUNTIME_STORE_BUCKETS &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    (value.bytes as number) <= MAX_SEGMENT_BYTES &&
    Number.isSafeInteger(value.entries) &&
    (value.entries as number) > 0 &&
    typeof value.sha256 === 'string' &&
    SHA256.test(value.sha256)
  )
}

function generationOf(
  metadata: Metadata,
  segments: RuntimeStateManifest['segments'],
): string {
  return digest(JSON.stringify({ metadata, segments }))
}

/**
 * Validates manifest text: format, version, reference shapes, and a generation
 * that matches the recomputed digest. Null for anything else.
 */
export function parseManifest(source: string): RuntimeStateManifest | null {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (
    !isRecord(value) ||
    value.version !== TIA_RUNTIME_STORE_VERSION ||
    value.format !== STORE_FORMAT ||
    typeof value.generation !== 'string' ||
    !SHA256.test(value.generation) ||
    !isRecord(value.metadata) ||
    !isRecord(value.segments)
  ) {
    return null
  }
  for (const domain of SEGMENT_DOMAINS) {
    const references = value.segments[domain]
    if (
      !Array.isArray(references) ||
      !references.every(segmentReference) ||
      new Set(references.map((reference) => reference.bucket)).size !==
        references.length
    ) {
      return null
    }
  }
  const segments = value.segments as RuntimeStateManifest['segments']
  if (generationOf(value.metadata, segments) !== value.generation) return null
  return {
    format: STORE_FORMAT,
    generation: value.generation,
    metadata: value.metadata,
    segments,
    version: TIA_RUNTIME_STORE_VERSION,
  }
}

/**
 * Validates one bucket object against its reference: byte length, digest,
 * JSON shape, and that every key hashes to the bucket. Returns its records.
 */
export function parseSegment(
  source: string,
  domain: SegmentDomain,
  reference: SegmentReference,
): Record<string, unknown> | null {
  if (
    Buffer.byteLength(source) !== reference.bytes ||
    digest(source) !== reference.sha256
  ) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  if (
    !isRecord(value) ||
    value.version !== TIA_RUNTIME_STORE_VERSION ||
    value.domain !== domain ||
    value.bucket !== reference.bucket ||
    !isRecord(value.records)
  ) {
    return null
  }
  // Every key must hash to this bucket; a bucket is listed once per domain,
  // so a key cannot repeat across buckets either.
  let count = 0
  for (const key in value.records) {
    if (bucketFor(key) !== reference.bucket) return null
    count += 1
  }
  return count === reference.entries ? value.records : null
}

/**
 * Rebuilds a graph value from a manifest and its validated bucket records
 * (one record object per reference). Null when the metadata has no baseline
 * object.
 */
export function assembleGraph(
  manifest: RuntimeStateManifest,
  records: Readonly<Record<SegmentDomain, readonly Record<string, unknown>[]>>,
): Record<string, unknown> | null {
  const domains = {} as Record<SegmentDomain, Record<string, unknown>>
  for (const domain of SEGMENT_DOMAINS) {
    const entries: Array<[string, unknown]> = []
    for (const bucket of records[domain]) {
      for (const key in bucket) entries.push([key, bucket[key]])
    }
    entries.sort(([left], [right]) => byCodeUnit(left, right))
    domains[domain] = Object.fromEntries(entries)
  }
  const { baseline } = manifest.metadata
  if (!isRecord(baseline)) return null
  const { workingTree, ...rest } = domains
  return {
    ...manifest.metadata,
    baseline: { ...baseline, workingTree },
    ...rest,
  }
}

function sortedObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => byCodeUnit(left, right)),
  )
}

/** Splits a graph into manifest metadata and the records of each domain. */
function stateRecords(
  graph: TiaRuntimeGraph,
): [Metadata, Record<SegmentDomain, object>] {
  const {
    baseline,
    collectionCoverage,
    coverageMaps,
    edges,
    results,
    testCoverage,
    testEdges,
    ...rest
  } = graph
  const { workingTree, ...baselineRest } = baseline
  const metadata: Metadata = sortedObject({
    ...rest,
    baseline: sortedObject(baselineRest),
    ...(rest.partition === undefined
      ? {}
      : { partition: sortedObject({ ...rest.partition }) }),
  })
  const referenced = referencedCoverageMaps(graph)
  return [
    metadata,
    {
      collectionCoverage,
      coverageMaps: Object.fromEntries(
        Object.entries(coverageMaps).filter(([id]) => referenced.has(id)),
      ),
      edges,
      results,
      testCoverage,
      testEdges,
      workingTree,
    },
  ]
}

function serializeSegment(
  domain: SegmentDomain,
  bucket: number,
  entries: Array<[string, unknown]>,
): SerializedSegment {
  entries.sort(([left], [right]) => byCodeUnit(left, right))
  const body = `${JSON.stringify({
    bucket,
    domain,
    records: Object.fromEntries(entries),
    version: TIA_RUNTIME_STORE_VERSION,
  })}\n`
  const bytes = Buffer.byteLength(body)
  if (bytes > MAX_SEGMENT_BYTES) {
    throw new Error(
      `TIA runtime ${domain} segment ${bucket} exceeds the storage limit`,
    )
  }
  return {
    body,
    domain,
    reference: { bucket, bytes, entries: entries.length, sha256: digest(body) },
  }
}

/**
 * Serializes the graph one bucket at a time. Each body is yielded and may be
 * released before the next is built; the generator returns the manifest.
 * Throws when a bucket exceeds the storage limit or the graph cannot be
 * serialized.
 */
export function* serializeGraph(
  graph: TiaRuntimeGraph,
): Generator<SerializedSegment, RuntimeStateManifest, undefined> {
  const [metadata, records] = stateRecords(graph)
  const segments = {} as Record<SegmentDomain, SegmentReference[]>
  for (const domain of SEGMENT_DOMAINS) {
    const buckets = new Map<number, Array<[string, unknown]>>()
    for (const [key, value] of Object.entries(records[domain])) {
      const bucket = bucketFor(key)
      const entries = buckets.get(bucket)
      if (entries === undefined) buckets.set(bucket, [[key, value]])
      else entries.push([key, value])
    }
    const references: SegmentReference[] = []
    for (const bucket of [...buckets.keys()].sort((a, b) => a - b)) {
      const segment = serializeSegment(domain, bucket, buckets.get(bucket)!)
      references.push(segment.reference)
      yield segment
    }
    segments[domain] = references
  }
  return {
    format: STORE_FORMAT,
    generation: generationOf(metadata, segments),
    metadata,
    segments,
    version: TIA_RUNTIME_STORE_VERSION,
  }
}

/**
 * The manifest generation the store would record for this graph. It
 * identifies graph content without serializing the graph into one string.
 */
export function graphGeneration(graph: TiaRuntimeGraph): string {
  const segments = serializeGraph(graph)
  for (;;) {
    const step = segments.next()
    if (step.done === true) return step.value.generation
  }
}

/** `graphGeneration`, with null for no graph. */
export function graphDigest(graph: TiaRuntimeGraph | null): string | null {
  return graph === null ? null : graphGeneration(graph)
}

/** The manifest file body, or throws when it exceeds the storage limit. */
export function manifestBody(manifest: RuntimeStateManifest): string {
  const body = `${JSON.stringify(manifest, null, 2)}\n`
  if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) {
    throw new Error('TIA runtime state manifest exceeds the storage limit')
  }
  return body
}

export function referencedObjects(manifest: RuntimeStateManifest): Set<string> {
  return new Set(
    SEGMENT_DOMAINS.flatMap((domain) =>
      manifest.segments[domain].map((reference) => reference.sha256),
    ),
  )
}
