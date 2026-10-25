import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

import { projectRelative } from '../../shared/paths.js'

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
    /^[A-Za-z0-9._:-]+$/.test(value)
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
    const target = resolve(
      targetDirectory,
      `${Date.now()}-${process.pid}-${randomUUID()}.json`,
    )
    const payload: TiaEvidenceEvent = {
      correlationId: id,
      files: normalized,
      producedAt: new Date().toISOString(),
      producer: this.producer,
      schema: 1,
    }
    await writeFile(target, `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
  }

  async collect(
    correlationId: string,
    options: { remove?: boolean } = {},
  ): Promise<string[]> {
    const id = this.correlationId(correlationId)
    const directory = correlationDirectory(this.directory, id)
    let entries: string[]
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return []
      entries = (await readdir(directory)).sort().slice(0, MAX_EVENTS)
    } catch {
      return []
    }
    const files = new Set<string>()
    for (const entryName of entries) {
      if (!entryName.endsWith('.json')) continue
      const path = resolve(directory, entryName)
      try {
        const stat = await lstat(path)
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > MAX_EVENT_BYTES
        ) {
          continue
        }
        const parsed = event(
          JSON.parse(await readFile(path, 'utf8')) as unknown,
          id,
        )
        for (const file of parsed?.files ?? []) files.add(file)
      } catch {
        // A partial or concurrently removed event is not trusted as evidence.
      }
    }
    if (options.remove === true) {
      await rm(directory, { force: true, recursive: true })
    }
    return [...files].sort()
  }
}

export function tia(options: TiaEvidenceOptions = {}): TiaEvidence {
  return new TiaEvidence(options)
}
