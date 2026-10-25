import { randomUUID } from 'node:crypto'
import {
  readFileSync,
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
  MAX_MANIFEST_BYTES,
  manifestBody,
  parseManifest,
  parseSegment,
  referencedObjects,
  SEGMENT_DOMAINS,
  serializeGraph,
  type RuntimeStateManifest,
  type SegmentDomain,
  type SegmentReference,
  type SerializedSegment,
} from './segments.ts'
import type { TiaRuntimeGraph } from '../../core/runtime.ts'

// The segmented store on a file system: reading, atomic writing, object
// garbage collection. Locking and the commit protocol live elsewhere.

const OBJECT_RETENTION_MS = 24 * 60 * 60 * 1_000
const TEMPORARY = /\.\d+\.[\da-f-]{36}\.tmp$/iu
const OBJECT = /^([a-f0-9]{64})\.json$/u
const GC_CONCURRENCY = 16

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
  try {
    // The manifest bounds `reference.bytes`; parseSegment rejects any object
    // whose length differs, so no stat is needed before the read.
    return parseSegment(
      readFileSync(objectPath(cacheDir, reference.sha256), 'utf8'),
      domain,
      reference,
    )
  } catch {
    return null
  }
}

/**
 * Stores one bucket object unless an intact copy exists (a corrupt object of
 * the same name is replaced). Reuse refreshes the object's mtime, so garbage
 * collection retains an object for 24 hours after it was last referenced.
 * Synchronous for the same reason as the read loop: it runs once per bucket.
 */
function storeObjectSync(cacheDir: string, segment: SerializedSegment): void {
  const path = objectPath(cacheDir, segment.reference.sha256)
  try {
    const current = readFileSync(path)
    if (
      current.byteLength === segment.reference.bytes &&
      hashBytes(current) === segment.reference.sha256
    ) {
      const now = new Date()
      try {
        utimesSync(path, now, now)
      } catch {
        // Refreshing the retention time is best effort.
      }
      return
    }
  } catch {
    // Missing or unreadable: write it below.
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, segment.body)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

const storeObject = (cacheDir: string, segment: SerializedSegment) =>
  Effect.try({
    catch: ioError,
    try: () => storeObjectSync(cacheDir, segment),
  })

const nextSegment = (
  generator: Generator<SerializedSegment, RuntimeStateManifest, undefined>,
) =>
  Effect.try({
    catch: ioError,
    try: () => generator.next(),
  })

export function makeStateFiles(fs: FileSystem.FileSystem) {
  /** The file's bytes, or null when missing, empty, oversized or unreadable. */
  const boundedFile = (path: string, maximum: number) =>
    fs.stat(path).pipe(
      Effect.flatMap((info) => {
        const size = Number(info.size)
        return info.type !== 'File' || size <= 0 || size > maximum
          ? Effect.succeed(null)
          : fs.readFile(path)
      }),
      Effect.orElseSucceed(() => null),
    )

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
    // A graph has hundreds of bucket objects. Node's asynchronous file reads
    // cost four thread-pool round trips each (about 60 ms for 380 files here
    // against 9 ms synchronously), so this per-file loop is plain TypeScript.
    const loaded = yield* Effect.sync(() =>
      jobs.map(({ domain, reference }) =>
        readSegmentSync(cacheDir, domain, reference),
      ),
    )
    const records = {} as Record<SegmentDomain, Record<string, unknown>[]>
    for (const domain of SEGMENT_DOMAINS) records[domain] = []
    for (const [index, segment] of loaded.entries()) {
      if (segment === null) return NO_GRAPH
      records[jobs[index]!.domain].push(segment)
    }
    const graph = parseRuntimeGraph(assembleGraph(manifest, records))
    return graph === null
      ? NO_GRAPH
      : ({ digest: manifest.generation, graph } satisfies StoredGraph)
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
   */
  const write = Effect.fnUntraced(function* (
    cacheDir: string,
    graph: TiaRuntimeGraph,
  ) {
    yield* fs
      .makeDirectory(objectsPath(cacheDir), { recursive: true })
      .pipe(Effect.mapError(ioError))
    const generator = serializeGraph(graph)
    let step = yield* nextSegment(generator)
    while (step.done !== true) {
      yield* storeObject(cacheDir, step.value)
      step = yield* nextSegment(generator)
    }
    const manifest = step.value
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
