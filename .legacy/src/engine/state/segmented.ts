import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { TiaRuntimeGraph } from '../types.js'
import { referencedCoverageMaps } from './coverage.js'

export const TIA_RUNTIME_STORE_VERSION = 2 as const
export const TIA_RUNTIME_STORE_BUCKETS = 64

const STORE_FORMAT = 'tiacore-runtime-state'
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_SEGMENT_BYTES = 20 * 1024 * 1024
const SEGMENT_DOMAINS = [
  'collectionCoverage',
  'coverageMaps',
  'edges',
  'results',
  'testCoverage',
  'testEdges',
] as const

type SegmentDomain = (typeof SEGMENT_DOMAINS)[number]

interface SegmentReference {
  bucket: number
  bytes: number
  entries: number
  sha256: string
}

interface RuntimeStateManifest {
  format: typeof STORE_FORMAT
  generation: string
  metadata: Omit<TiaRuntimeGraph, SegmentDomain>
  segments: Record<SegmentDomain, SegmentReference[]>
  version: typeof TIA_RUNTIME_STORE_VERSION
}

interface RuntimeStateSegment {
  bucket: number
  domain: SegmentDomain
  records: Record<string, unknown>
  version: typeof TIA_RUNTIME_STORE_VERSION
}

interface SerializedSegment {
  body: string
  reference: SegmentReference
}

export function statePath(cacheDir: string): string {
  return join(cacheDir, 'state.json')
}

export function stateObjectsPath(cacheDir: string): string {
  return join(cacheDir, 'objects')
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function bucketFor(key: string): number {
  return (
    createHash('sha256').update(key).digest()[0]! % TIA_RUNTIME_STORE_BUCKETS
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function segmentReference(value: unknown): value is SegmentReference {
  if (!isRecord(value)) return false
  return (
    Number.isInteger(value.bucket) &&
    (value.bucket as number) >= 0 &&
    (value.bucket as number) < TIA_RUNTIME_STORE_BUCKETS &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    (value.bytes as number) <= MAX_SEGMENT_BYTES &&
    Number.isSafeInteger(value.entries) &&
    (value.entries as number) > 0 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256)
  )
}

function manifest(value: unknown): RuntimeStateManifest | null {
  if (!isRecord(value)) return null
  if (
    value.version !== TIA_RUNTIME_STORE_VERSION ||
    value.format !== STORE_FORMAT ||
    typeof value.generation !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.generation) ||
    !isRecord(value.metadata) ||
    !isRecord(value.segments)
  ) {
    return null
  }

  const segments = value.segments
  for (const domain of SEGMENT_DOMAINS) {
    const references = segments[domain]
    if (
      !Array.isArray(references) ||
      !references.every(segmentReference) ||
      new Set(references.map((reference) => reference.bucket)).size !==
        references.length
    ) {
      return null
    }
  }

  const candidate = value as unknown as RuntimeStateManifest
  const generation = digest(
    JSON.stringify({
      metadata: candidate.metadata,
      segments: candidate.segments,
    }),
  )
  return generation === candidate.generation ? candidate : null
}

function boundedFile(path: string, maximum: number): string | null {
  try {
    const size = statSync(path).size
    if (size <= 0 || size > maximum) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function parseSegment(
  source: string,
  domain: SegmentDomain,
  reference: SegmentReference,
): RuntimeStateSegment | null {
  if (
    Buffer.byteLength(source) !== reference.bytes ||
    digest(source) !== reference.sha256
  ) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (
    value.version !== TIA_RUNTIME_STORE_VERSION ||
    value.domain !== domain ||
    value.bucket !== reference.bucket ||
    !isRecord(value.records) ||
    Object.keys(value.records).length !== reference.entries ||
    Object.keys(value.records).some(
      (key) => bucketFor(key) !== reference.bucket,
    )
  ) {
    return null
  }
  return value as unknown as RuntimeStateSegment
}

export function readSegmentedState(cacheDir: string): unknown | null {
  const manifestSource = boundedFile(statePath(cacheDir), MAX_MANIFEST_BYTES)
  if (manifestSource === null) return null

  let parsedManifest: unknown
  try {
    parsedManifest = JSON.parse(manifestSource) as unknown
  } catch {
    return null
  }
  const current = manifest(parsedManifest)
  if (current === null) return null

  const graph: Record<string, unknown> = {
    ...current.metadata,
  }
  for (const domain of SEGMENT_DOMAINS) {
    const records: Record<string, unknown> = {}
    for (const reference of current.segments[domain]) {
      const source = boundedFile(
        join(stateObjectsPath(cacheDir), `${reference.sha256}.json`),
        MAX_SEGMENT_BYTES,
      )
      if (source === null) return null
      const segment = parseSegment(source, domain, reference)
      if (segment === null) return null
      for (const [key, value] of Object.entries(segment.records)) {
        if (key in records) return null
        records[key] = value
      }
    }
    graph[domain] = Object.fromEntries(
      Object.entries(records).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    )
  }
  return graph
}

function serializeSegment(
  domain: SegmentDomain,
  bucket: number,
  entries: Array<[string, unknown]>,
): SerializedSegment {
  const records = Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  )
  const body = `${JSON.stringify({
    bucket,
    domain,
    records,
    version: TIA_RUNTIME_STORE_VERSION,
  } satisfies RuntimeStateSegment)}\n`
  const bytes = Buffer.byteLength(body)
  if (bytes > MAX_SEGMENT_BYTES) {
    throw new Error(
      `TIA runtime ${domain} segment ${bucket} exceeds the storage limit`,
    )
  }
  return {
    body,
    reference: { bucket, bytes, entries: entries.length, sha256: digest(body) },
  }
}

function stateRecords(
  graph: TiaRuntimeGraph,
): [Omit<TiaRuntimeGraph, SegmentDomain>, Record<SegmentDomain, object>] {
  const {
    collectionCoverage,
    coverageMaps,
    edges,
    results,
    testCoverage,
    testEdges,
    ...metadata
  } = graph
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
    },
  ]
}

/**
 * Serializes the graph one bucket at a time. Each body is handed to `visit`
 * and released before the next is built, so no string holds the whole graph.
 */
function visitSegments(
  graph: TiaRuntimeGraph,
  visit: (segment: SerializedSegment) => void,
): RuntimeStateManifest {
  const [metadata, records] = stateRecords(graph)
  const segments = {} as Record<SegmentDomain, SegmentReference[]>
  for (const domain of SEGMENT_DOMAINS) {
    const buckets = new Map<number, Array<[string, unknown]>>()
    for (const [key, value] of Object.entries(records[domain])) {
      const bucket = bucketFor(key)
      const entries = buckets.get(bucket) ?? []
      entries.push([key, value])
      buckets.set(bucket, entries)
    }
    segments[domain] = [...buckets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([bucket, entries]) => {
        const segment = serializeSegment(domain, bucket, entries)
        visit(segment)
        return segment.reference
      })
  }
  return {
    format: STORE_FORMAT,
    generation: digest(JSON.stringify({ metadata, segments })),
    metadata,
    segments,
    version: TIA_RUNTIME_STORE_VERSION,
  }
}

/**
 * Returns the manifest generation the store would record for this graph. It
 * identifies graph content without serializing the graph into one string.
 */
export function stateGeneration(graph: TiaRuntimeGraph): string {
  return visitSegments(graph, () => {}).generation
}

/** Reads the generation of the current manifest without loading segments. */
export function readStateGeneration(cacheDir: string): string | null {
  const source = boundedFile(statePath(cacheDir), MAX_MANIFEST_BYTES)
  if (source === null) return null
  try {
    return manifest(JSON.parse(source) as unknown)?.generation ?? null
  } catch {
    return null
  }
}

function atomicWrite(path: string, body: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, body, 'utf8')
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function storeObject(cacheDir: string, segment: SerializedSegment): void {
  const path = join(
    stateObjectsPath(cacheDir),
    `${segment.reference.sha256}.json`,
  )
  const current = boundedFile(path, MAX_SEGMENT_BYTES)
  if (current !== null && digest(current) === segment.reference.sha256) {
    return
  }
  atomicWrite(path, segment.body)
}

function garbageCollectObjects(
  cacheDir: string,
  referenced: Set<string>,
): void {
  const directory = stateObjectsPath(cacheDir)
  const staleBefore = Date.now() - 24 * 60 * 60 * 1_000
  try {
    for (const entry of readdirSync(directory)) {
      const match = /^([a-f0-9]{64})\.json$/.exec(entry)
      if (match === null || referenced.has(match[1]!)) continue
      const path = join(directory, entry)
      if (statSync(path).mtimeMs < staleBefore) {
        rmSync(path, { force: true })
      }
    }
  } catch {
    // Garbage collection is best effort and never affects the active state.
  }
}

export function writeSegmentedState(
  cacheDir: string,
  graph: TiaRuntimeGraph,
): void {
  mkdirSync(stateObjectsPath(cacheDir), { recursive: true })
  const state = visitSegments(graph, (segment) => {
    storeObject(cacheDir, segment)
  })
  const body = `${JSON.stringify(state, null, 2)}\n`
  if (Buffer.byteLength(body) > MAX_MANIFEST_BYTES) {
    throw new Error('TIA runtime state manifest exceeds the storage limit')
  }

  atomicWrite(statePath(cacheDir), body)
  garbageCollectObjects(
    cacheDir,
    new Set(
      Object.values(state.segments).flatMap((references) =>
        references.map((reference) => reference.sha256),
      ),
    ),
  )
}

export function purgeSegmentedState(cacheDir: string): void {
  rmSync(statePath(cacheDir), { force: true })
}

export function cleanSegmentedWrites(cacheDir: string): void {
  for (const directory of [cacheDir, stateObjectsPath(cacheDir)]) {
    try {
      for (const entry of readdirSync(directory)) {
        if (/\.\d+\.[\da-f-]{36}\.tmp$/i.test(entry)) {
          rmSync(join(directory, entry), { force: true })
        }
      }
    } catch {
      // A missing directory is expected before the first graph commit.
    }
  }
}

export function runtimeStateExists(cacheDir: string): boolean {
  return existsSync(statePath(cacheDir))
}
