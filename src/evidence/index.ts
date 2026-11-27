import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

import { projectRelative } from './project-relative.ts'

export const TIA_EVIDENCE_DIRECTORY_ENV = 'TIA_EVIDENCE_DIRECTORY'
export const TIA_EVIDENCE_HEADER_ENV = 'TIA_EVIDENCE_HEADER'
export const DEFAULT_TIA_EVIDENCE_HEADER = 'x-tiacore-correlation-id'

const MAX_CORRELATION_LENGTH = 256
const MAX_EVENTS = 10_000
const MAX_EVENT_BYTES = 1024 * 1024
const MAX_FILES_PER_EVENT = 1_000
const correlation = new AsyncLocalStorage<string>()

export interface TiaEvidenceEvent {
  correlationId: string
  files: string[]
  producedAt: string
  producer: string
  schema: 1
}

/** What `collectChecked` read. `complete` is false when an event was lost. */
export interface TiaEvidenceCollection {
  complete: boolean
  files: string[]
}

export interface TiaEvidenceOptions {
  directory?: string
  header?: string
  producer?: string
  root?: string
}

function validCorrelationId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CORRELATION_LENGTH &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  )
}

function correlationDirectory(directory: string, id: string): string {
  return resolve(directory, createHash('sha256').update(id).digest('hex'))
}

function headerValue(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name)
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
  }
  return null
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/**
 * Writes one event under a temporary name and renames it, so a reader never
 * sees a partial event under its final name. A collector that removed the
 * emptied directory in between does not lose the event, and a failed rename
 * leaves no temporary file that would make every later collection incomplete.
 */
async function writeEvent(
  directory: string,
  name: string,
  text: string,
): Promise<void> {
  const temporary = resolve(directory, `${name}.tmp`)
  const write = () =>
    writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
  try {
    await write()
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    await mkdir(directory, { recursive: true })
    await write()
  }
  try {
    await rename(temporary, resolve(directory, `${name}.json`))
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Removes what a collection listed. An event still being written (`.tmp`)
 * stays, and so does the directory while anything is left in it, so a writer
 * that is mid-way through `record` can still finish.
 */
async function removeCollected(
  directory: string,
  entries: readonly string[],
): Promise<void> {
  await Promise.all(
    entries
      .filter((name) => !name.endsWith('.tmp'))
      .map((name) =>
        rm(resolve(directory, name), { force: true, recursive: true }),
      ),
  )
  try {
    await rmdir(directory)
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      throw error
    }
  }
}

function event(value: unknown, id: string): TiaEvidenceEvent | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Partial<TiaEvidenceEvent>
  if (
    candidate.schema !== 1 ||
    candidate.correlationId !== id ||
    typeof candidate.producedAt !== 'string' ||
    typeof candidate.producer !== 'string' ||
    !Array.isArray(candidate.files) ||
    candidate.files.length > MAX_FILES_PER_EVENT ||
    !candidate.files.every((file) => typeof file === 'string')
  ) {
    return null
  }
  return candidate as TiaEvidenceEvent
}

export class TiaEvidence {
  readonly directory: string
  readonly header: string
  readonly producer: string
  readonly root: string

  constructor(options: TiaEvidenceOptions = {}) {
    this.root = resolve(options.root ?? process.cwd())
    this.directory = resolve(
      this.root,
      options.directory ??
        process.env[TIA_EVIDENCE_DIRECTORY_ENV] ??
        '.tia/evidence',
    )
    this.header = (
      options.header ??
      process.env[TIA_EVIDENCE_HEADER_ENV] ??
      DEFAULT_TIA_EVIDENCE_HEADER
    ).toLowerCase()
    this.producer = options.producer ?? `${process.release.name}:${process.pid}`
  }

  correlationId(value: string = randomUUID()): string {
    if (!validCorrelationId(value)) {
      throw new Error('TIA evidence correlation id is invalid')
    }
    return value
  }

  currentCorrelationId(): string | null {
    return correlation.getStore() ?? null
  }

  fromHeaders(
    headers: Headers | Record<string, string | string[] | undefined>,
  ): string | null {
    const value = headerValue(headers, this.header)
    return value !== null && validCorrelationId(value) ? value : null
  }

  headers(correlationId: string): Record<string, string> {
    return { [this.header]: this.correlationId(correlationId) }
  }

  run<Result>(correlationId: string, callback: () => Result): Result {
    return correlation.run(this.correlationId(correlationId), callback)
  }

  async record(
    files: Iterable<string>,
    correlationId = this.currentCorrelationId(),
  ): Promise<void> {
    if (correlationId === null) return
    const id = this.correlationId(correlationId)
    const normalized = [
      ...new Set(
        [...files].flatMap((file) => {
          const relative = projectRelative(this.root, resolve(this.root, file))
          return relative === null || relative === '' ? [] : [relative]
        }),
      ),
    ].sort()
    if (normalized.length === 0) return
    if (normalized.length > MAX_FILES_PER_EVENT) {
      throw new Error('TIA evidence event contains too many files')
    }
    const targetDirectory = correlationDirectory(this.directory, id)
    await mkdir(targetDirectory, { recursive: true })
    const payload: TiaEvidenceEvent = {
      correlationId: id,
      files: normalized,
      producedAt: new Date().toISOString(),
      producer: this.producer,
      schema: 1,
    }
    await writeEvent(
      targetDirectory,
      `${Date.now()}-${process.pid}-${randomUUID()}`,
      `${JSON.stringify(payload)}\n`,
    )
  }

  /** The files recorded for `correlationId`. See `collectChecked`. */
  async collect(
    correlationId: string,
    options: { remove?: boolean } = {},
  ): Promise<string[]> {
    return (await this.collectChecked(correlationId, options)).files
  }

  /**
   * The files recorded for `correlationId`, and whether every event was read.
   * An event that cannot be read or validated, an event still being written,
   * more events than the bound, or an unexpected directory makes the
   * collection incomplete: its files are a subset of what was recorded.
   */
  async collectChecked(
    correlationId: string,
    options: { remove?: boolean } = {},
  ): Promise<TiaEvidenceCollection> {
    const id = this.correlationId(correlationId)
    const directory = correlationDirectory(this.directory, id)
    let entries: string[]
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return { complete: false, files: [] }
      }
      entries = (await readdir(directory)).sort()
    } catch (error) {
      return { complete: errorCode(error) === 'ENOENT', files: [] }
    }
    let complete = entries.length <= MAX_EVENTS
    const files = new Set<string>()
    for (const entryName of entries.slice(0, MAX_EVENTS)) {
      if (!entryName.endsWith('.json')) {
        complete = false
        continue
      }
      const path = resolve(directory, entryName)
      try {
        const stat = await lstat(path)
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > MAX_EVENT_BYTES
        ) {
          complete = false
          continue
        }
        const parsed = event(
          JSON.parse(await readFile(path, 'utf8')) as unknown,
          id,
        )
        if (parsed === null) complete = false
        for (const file of parsed?.files ?? []) files.add(file)
      } catch {
        complete = false
      }
    }
    if (options.remove === true) await removeCollected(directory, entries)
    return { complete, files: [...files].sort() }
  }
}

export function tia(options: TiaEvidenceOptions = {}): TiaEvidence {
  return new TiaEvidence(options)
}
