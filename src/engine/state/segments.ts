import { hash } from 'node:crypto'

import { byCodeUnit } from '../../core/canonical.ts'
import { isRecord } from '../../core/record.ts'
import { RECORD_FAMILIES, type TiaRuntimeGraph } from '../../core/runtime.ts'
import { hashBytes } from '../baseline/fingerprint.ts'
import { referencedCoverageMaps } from './coverage.ts'

// The segmented runtime-state layout. A graph is a small manifest plus
// content-addressed bucket objects, so no code path ever holds the whole graph
// as one string. Everything here is synchronous and pure; the stores add the
// file system on top.
//
// Bucket records are ordered by UTF-16 code unit, and `baseline.workingTree`
// is a segment domain of its own, so a large dirty tree does not count against
// the manifest's size limit.

export const TIA_RUNTIME_STORE_VERSION = 4 as const
export const TIA_RUNTIME_STORE_BUCKETS = 64
export const MAX_MANIFEST_BYTES = 1024 * 1024
export const MAX_SEGMENT_BYTES = 20 * 1024 * 1024

const STORE_FORMAT = 'tiacore-runtime-state'

export const SEGMENT_DOMAINS = [...RECORD_FAMILIES, 'workingTree'] as const

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

export function bucketFor(key: string): number {
  return (
    parseInt(hash('sha256', key, 'hex').slice(0, 2), 16) %
    TIA_RUNTIME_STORE_BUCKETS
  )
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
  return hashBytes(JSON.stringify({ metadata, segments }))
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
    hashBytes(source) !== reference.sha256
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

const FAMILY_KEYS: ReadonlySet<string> = new Set(RECORD_FAMILIES)

/**
 * Splits a graph into manifest metadata and the records of each domain. Every
 * field that is not a record family or the baseline lands in the metadata.
 */
function stateRecords(
  graph: TiaRuntimeGraph,
): [Metadata, Record<SegmentDomain, object>] {
  const { workingTree, ...baselineRest } = graph.baseline
  const header = Object.entries(graph).filter(
    ([key]) => key !== 'baseline' && !FAMILY_KEYS.has(key),
  )
  const metadata: Metadata = sortedObject({
    ...Object.fromEntries(header),
    baseline: sortedObject(baselineRest),
    ...(graph.partition === undefined
      ? {}
      : { partition: sortedObject({ ...graph.partition }) }),
  })
  const referenced = referencedCoverageMaps(graph)
  const records = { workingTree } as Record<SegmentDomain, object>
  for (const family of RECORD_FAMILIES) records[family] = graph[family]
  records.coverageMaps = Object.fromEntries(
    Object.entries(graph.coverageMaps).filter(([id]) => referenced.has(id)),
  )
  return [metadata, records]
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
    reference: {
      bucket,
      bytes,
      entries: entries.length,
      sha256: hashBytes(body),
    },
  }
}

/**
 * The bucket objects a store read, per domain and bucket: each one's
 * reference and the records it held. The records are the very values of the
 * graph the store assembled from them.
 */
export type StoredSegments = Readonly<
  Record<SegmentDomain, ReadonlyMap<number, StoredSegment>>
>

export interface StoredSegment {
  readonly records: Readonly<Record<string, unknown>>
  readonly reference: SegmentReference
}

/**
 * One bucket of a graph being written. `stored` is the reference of a stored
 * object that holds exactly this bucket's records, when one is known; the
 * bucket then serializes to that object's body, and a writer that finds the
 * object intact need not serialize it.
 */
export interface PendingSegment {
  readonly serialize: () => SerializedSegment
  readonly stored: SegmentReference | null
}

/** True when `entries` are exactly the records `stored` held, value for value. */
function holdsExactly(
  stored: StoredSegment,
  entries: ReadonlyArray<readonly [string, unknown]>,
): boolean {
  if (entries.length !== stored.reference.entries) return false
  for (const [key, value] of entries) {
    if (!Object.hasOwn(stored.records, key) || stored.records[key] !== value) {
      return false
    }
  }
  return true
}

/**
 * The graph's buckets, one at a time, each matched against the buckets
 * `known` (from the store's read of an earlier graph) by key and value
 * identity. Graph values are never changed in place, so an identical bucket
 * still serializes to the object it was read from. The caller passes the
 * reference it stored each bucket at to `next`; the generator returns the
 * manifest. Throws when a bucket exceeds the storage limit or the graph cannot
 * be serialized.
 */
export function* segmentsOf(
  graph: TiaRuntimeGraph,
  known: StoredSegments | null,
): Generator<PendingSegment, RuntimeStateManifest, SegmentReference> {
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
      const entries = buckets.get(bucket)!
      const stored = known?.[domain].get(bucket)
      references.push(
        yield {
          serialize: () => serializeSegment(domain, bucket, entries),
          stored:
            stored !== undefined && holdsExactly(stored, entries)
              ? stored.reference
              : null,
        },
      )
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
 * Serializes the graph one bucket at a time. Each body is yielded and may be
 * released before the next is built; the generator returns the manifest.
 * Throws when a bucket exceeds the storage limit or the graph cannot be
 * serialized.
 */
export function* serializeGraph(
  graph: TiaRuntimeGraph,
): Generator<SerializedSegment, RuntimeStateManifest, undefined> {
  const pending = segmentsOf(graph, null)
  let step = pending.next()
  while (step.done !== true) {
    const segment = step.value.serialize()
    yield segment
    step = pending.next(segment.reference)
  }
  return step.value
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

/**
 * The bucket objects each graph the store read was assembled from, so a write
 * of a graph derived from it can recognise the buckets it left unchanged.
 */
const knownSegments = new WeakMap<TiaRuntimeGraph, StoredSegments>()

/** Records the bucket objects the store assembled `graph` from. */
export function noteGraphSegments(
  graph: TiaRuntimeGraph,
  segments: StoredSegments,
): void {
  knownSegments.set(graph, segments)
}

/** The bucket objects the store assembled `graph` from, when it read it. */
export function graphSegments(
  graph: TiaRuntimeGraph | null,
): StoredSegments | null {
  return graph === null ? null : (knownSegments.get(graph) ?? null)
}

/**
 * The digests the store read or wrote each graph object at. Serializing a
 * graph to digest it costs as much as writing it, and a commit checks the
 * graph its caller read. Graph objects are never changed in place: updates
 * clone them, so an object keeps the digest it was read or written at.
 */
const knownDigests = new WeakMap<TiaRuntimeGraph, string>()

/** Records that `graph` was read or written at `digest`. */
export function noteGraphDigest(graph: TiaRuntimeGraph, digest: string): void {
  knownDigests.set(graph, digest)
}

/** `graphGeneration`, with null for no graph. */
export function graphDigest(graph: TiaRuntimeGraph | null): string | null {
  if (graph === null) return null
  return knownDigests.get(graph) ?? graphGeneration(graph)
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
