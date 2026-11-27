import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'

import type { StoredGraph } from '../ports.ts'
import { ioError } from '../../wire/errors.ts'
import { hashBytes } from '../baseline/fingerprint.ts'
import { parseRuntimeGraph } from '../../wire/runtime-graph.ts'
import {
  assembleGraph,
  graphSegments,
  MAX_MANIFEST_BYTES,
  manifestBody,
  parseManifest,
  noteGraphDigest,
  noteGraphSegments,
  parseSegment,
  referencedObjects,
  SEGMENT_DOMAINS,
  segmentsOf,
  type PendingSegment,
  type RuntimeStateManifest,
  type SegmentDomain,
  type SegmentReference,
  type StoredSegment,
} from './segments.ts'
import type { TiaRuntimeGraph } from '../../core/runtime.ts'

// The segmented store on a file system: reading, atomic writing, object
// garbage collection. Locking and the commit protocol live elsewhere.

const OBJECT_RETENTION_MS = 24 * 60 * 60 * 1_000
const TEMPORARY = /\.\d+\.[\da-f-]{36}\.tmp$/iu
const OBJECT = /^([a-f0-9]{64})\.json$/u
const GC_CONCURRENCY = 16
const SEGMENTS_PER_TURN = 16

const yieldToEventLoop = () =>
  Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

export const NO_GRAPH: StoredGraph = { digest: null, graph: null }

export const statePath = (cacheDir: string): string =>
  join(cacheDir, 'state.json')
export const objectsPath = (cacheDir: string): string =>
  join(cacheDir, 'objects')

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'utf8',
  )
}

const objectPath = (cacheDir: string, sha256: string): string =>
  join(objectsPath(cacheDir), `${sha256}.json`)

function readSegmentSync(
  cacheDir: string,
  domain: SegmentDomain,
  reference: SegmentReference,
): Record<string, unknown> | null {
  const bytes = readObject(
    objectPath(cacheDir, reference.sha256),
    reference.bytes,
  )
  return bytes === null
    ? null
    : parseSegment(bytes.toString('utf8'), domain, reference)
}

/** Read at most the validated manifest length, even if the cache file grows. */
function readObject(path: string, length: number): Buffer | null {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== length) return null
    const bytes = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, offset)
      if (count === 0) return null
      offset += count
    }
    return bytes
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * True when an intact copy of the object exists. Reuse refreshes the object's
 * mtime, so garbage collection retains an object for 24 hours after it was
 * last referenced.
 */
function keepIntactObject(
  cacheDir: string,
  reference: SegmentReference,
): boolean {
  const path = objectPath(cacheDir, reference.sha256)
  const current = readObject(path, reference.bytes)
  if (current === null || hashBytes(current) !== reference.sha256) return false
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    // Refreshing the retention time is best effort.
  }
  return true
}

/**
 * Stores one bucket object unless an intact copy exists (a corrupt object of
 * the same name is replaced) and returns its reference. A bucket that holds
 * the records of a known object is serialized only when that object is not
 * intact here. Synchronous for the same reason as the read loop: it runs once
 * per bucket.
 */
function storeObjectSync(
  cacheDir: string,
  pending: PendingSegment,
): SegmentReference {
  if (pending.stored !== null && keepIntactObject(cacheDir, pending.stored)) {
    return pending.stored
  }
  const segment = pending.serialize()
  if (keepIntactObject(cacheDir, segment.reference)) return segment.reference
  const path = objectPath(cacheDir, segment.reference.sha256)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, segment.body)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return segment.reference
}

const storeObject = (cacheDir: string, pending: PendingSegment) =>
  Effect.try({
    catch: ioError,
    try: () => storeObjectSync(cacheDir, pending),
  })

const nextSegment = (
  generator: Generator<PendingSegment, RuntimeStateManifest, SegmentReference>,
  stored?: SegmentReference,
) =>
  Effect.try({
    catch: ioError,
    try: () =>
      stored === undefined ? generator.next() : generator.next(stored),
  })

export function makeStateFiles(fs: FileSystem.FileSystem) {
  /**
   * The file's bytes, or null when missing, empty, oversized or unreadable.
   * The size is taken from the open file and only that many bytes are read,
   * so a file swapped in after the check by path is never read whole.
   */
  const boundedFile = (path: string, maximum: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Checked by path first: opening a FIFO would block.
        if ((yield* fs.stat(path)).type !== 'File') return null
        const file = yield* fs.open(path, { flag: 'r' })
        const info = yield* file.stat
        const size = Number(info.size)
        if (info.type !== 'File' || size <= 0 || size > maximum) return null
        const bytes = new Uint8Array(size)
        let offset = 0
        while (offset < size) {
          const count = Number(yield* file.read(bytes.subarray(offset)))
          if (count === 0) return null
          offset += count
        }
        return bytes
      }),
    ).pipe(Effect.orElseSucceed(() => null))

  const readManifest = Effect.fnUntraced(function* (cacheDir: string) {
    const bytes = yield* boundedFile(statePath(cacheDir), MAX_MANIFEST_BYTES)
    return bytes === null ? null : parseManifest(utf8(bytes))
  })

  /** The generation of the current manifest, without loading any segment. */
  const readGeneration = (cacheDir: string) =>
    readManifest(cacheDir).pipe(
      Effect.map((manifest) => manifest?.generation ?? null),
    )

  const readValidated = Effect.fnUntraced(function* (cacheDir: string) {
    const manifest = yield* readManifest(cacheDir)
    if (manifest === null) return NO_GRAPH
    const jobs = SEGMENT_DOMAINS.flatMap((domain) =>
      manifest.segments[domain].map((reference) => ({ domain, reference })),
    )
    const records = {} as Record<SegmentDomain, Record<string, unknown>[]>
    const segments = {} as Record<SegmentDomain, Map<number, StoredSegment>>
    for (const domain of SEGMENT_DOMAINS) {
      records[domain] = []
      segments[domain] = new Map()
    }
    // Synchronous reads avoid the per-file thread-pool overhead. Yield between
    // batches so a large store does not monopolize the event loop.
    for (const [index, { domain, reference }] of jobs.entries()) {
      if (index > 0 && index % SEGMENTS_PER_TURN === 0) {
        yield* yieldToEventLoop()
      }
      const segment = readSegmentSync(cacheDir, domain, reference)
      if (segment === null) return NO_GRAPH
      records[domain].push(segment)
      segments[domain].set(reference.bucket, { records: segment, reference })
    }
    const graph = parseRuntimeGraph(assembleGraph(manifest, records))
    if (graph === null) return NO_GRAPH
    noteGraphDigest(graph, manifest.generation)
    noteGraphSegments(graph, segments)
    return { digest: manifest.generation, graph } satisfies StoredGraph
  })

  /** Reads and validates the stored graph. Anything wrong reads as no graph. */
  const read = (cacheDir: string): Effect.Effect<StoredGraph> =>
    readValidated(cacheDir).pipe(
      Effect.catchCause(() => Effect.succeed(NO_GRAPH)),
    )

  const atomicWrite = (path: string, body: string) => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    return fs.writeFileString(temporary, body).pipe(
      Effect.flatMap(() => fs.rename(temporary, path)),
      Effect.ensuring(
        fs.remove(temporary, { force: true }).pipe(Effect.ignore),
      ),
    )
  }

  const collectGarbage = Effect.fnUntraced(
    function* (cacheDir: string, referenced: ReadonlySet<string>) {
      const directory = objectsPath(cacheDir)
      const staleBefore = Date.now() - OBJECT_RETENTION_MS
      const entries = yield* fs.readDirectory(directory)
      yield* Effect.forEach(
        entries,
        (entry) => {
          const match = OBJECT.exec(entry)
          if (match === null || referenced.has(match[1]!)) return Effect.void
          const path = join(directory, entry)
          return fs.stat(path).pipe(
            Effect.flatMap((info) =>
              Option.exists(info.mtime, (time) => time.getTime() < staleBefore)
                ? fs.remove(path, { force: true })
                : Effect.void,
            ),
            Effect.ignore,
          )
        },
        { concurrency: GC_CONCURRENCY, discard: true },
      )
    },
    (self) => Effect.ignore(self),
  )

  /**
   * Stores every bucket object as it is serialized, checks the manifest size,
   * then renames the manifest into place (the commit point) and collects
   * garbage. A failure before the rename leaves the previous manifest in force.
   * `base` is a graph this store read that `graph` was derived from: buckets
   * that hold the same records reuse its objects without serializing them.
   */
  const write = Effect.fnUntraced(function* (
    cacheDir: string,
    graph: TiaRuntimeGraph,
    base: TiaRuntimeGraph | null,
  ) {
    yield* fs
      .makeDirectory(objectsPath(cacheDir), { recursive: true })
      .pipe(Effect.mapError(ioError))
    const generator = segmentsOf(graph, graphSegments(base))
    let step = yield* nextSegment(generator)
    let stored = 0
    while (step.done !== true) {
      if (stored > 0 && stored % SEGMENTS_PER_TURN === 0) {
        yield* yieldToEventLoop()
      }
      const reference = yield* storeObject(cacheDir, step.value)
      stored += 1
      step = yield* nextSegment(generator, reference)
    }
    const manifest = step.value
    noteGraphDigest(graph, manifest.generation)
    const body = yield* Effect.try({
      catch: ioError,
      try: () => manifestBody(manifest),
    })
    yield* atomicWrite(statePath(cacheDir), body).pipe(Effect.mapError(ioError))
    yield* collectGarbage(cacheDir, referencedObjects(manifest))
  })

  /** Removes the manifest only; objects, fragments and the lock stay. */
  const purge = (cacheDir: string) =>
    fs
      .remove(statePath(cacheDir), { force: true })
      .pipe(Effect.mapError(ioError))

  /** Deletes temporary files an interrupted writer left behind. */
  const cleanAbandonedWrites = (cacheDir: string) =>
    Effect.forEach(
      [cacheDir, objectsPath(cacheDir)],
      (directory) =>
        fs.readDirectory(directory).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((entry) => TEMPORARY.test(entry)),
              (entry) => fs.remove(join(directory, entry), { force: true }),
              { discard: true },
            ),
          ),
          Effect.ignore,
        ),
      { discard: true },
    )

  return { cleanAbandonedWrites, purge, read, readGeneration, write }
}

export type StateFiles = ReturnType<typeof makeStateFiles>
