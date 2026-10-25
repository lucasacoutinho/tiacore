import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FlattenMap, eachMapping } from '@jridgewell/trace-mapping'

import { byCodeUnit } from '../../core/canonical.ts'
import { projectFile } from '../../engine/host-path.ts'

const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024
const SOURCE_MAP_SUFFIX = /(?:\.bundle|\.m?js)$/iu
/** Entries each memo keeps; the oldest-used entry is dropped past this. */
export const SOURCE_MAP_CACHE_LIMIT = 256

export interface PlaywrightCoverageFunction {
  ranges: Array<{
    count: number
    endOffset: number
    startOffset: number
  }>
}

interface CoverageRange {
  count: number
  end: number
  length: number
  start: number
}

/**
 * A memo of pending lookups that forgets the least recently used entry past
 * its limit. 1.x memoized for the life of the process, which grew with every
 * distinct script URL a long-lived Playwright worker saw.
 */
class BoundedMemo<V> {
  private readonly entries = new Map<string, V>()

  get(key: string, compute: () => V): V {
    const cached = this.entries.get(key)
    if (cached !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached
    }
    const value = compute()
    this.entries.set(key, value)
    if (this.entries.size > SOURCE_MAP_CACHE_LIMIT) {
      const oldest = this.entries.keys().next()
      if (oldest.done !== true) this.entries.delete(oldest.value)
    }
    return value
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

const sourceMapMemo = new BoundedMemo<Promise<string[]>>()
const textMemo = new BoundedMemo<Promise<string | null>>()

/** Forgets every memoized script, map and attribution. */
export function clearSourceMapCaches(): void {
  sourceMapMemo.clear()
  textMemo.clear()
}

/** How many entries the two memos hold, for the leak test. */
export function sourceMapCacheSize(): number {
  return sourceMapMemo.size + textMemo.size
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function mappedSources(map: unknown): string[] {
  if (typeof map !== 'object' || map === null) return []
  const sourceRoot =
    'sourceRoot' in map && typeof map.sourceRoot === 'string'
      ? map.sourceRoot
      : undefined
  const sources = 'sources' in map ? strings(map.sources) : []
  const sections =
    'sections' in map && Array.isArray(map.sections) ? map.sections : []
  return [
    ...sources.map((source) =>
      sourceRoot === undefined
        ? source
        : `${sourceRoot.replace(/\/+$/u, '')}/${source.replace(/^\/+/u, '')}`,
    ),
    ...sections.flatMap((section: unknown) =>
      typeof section === 'object' && section !== null && 'map' in section
        ? mappedSources(section.map)
        : [],
    ),
  ]
}

function decodedDataUrl(value: string): string | null {
  const match =
    /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/isu.exec(value)
  if (match === null) return null
  const body = match[2] ?? ''
  try {
    return match[1] === undefined
      ? decodeURIComponent(body)
      : Buffer.from(body, 'base64').toString('utf8')
  } catch {
    return null
  }
}

async function uncachedBoundedText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      // An unread body would hold its connection open.
      await response.body?.cancel()
      return null
    }

    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_SOURCE_MAP_BYTES) {
      await response.body?.cancel()
      return null
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > MAX_SOURCE_MAP_BYTES
      ? null
      : Buffer.from(bytes).toString('utf8')
  } catch {
    return null
  }
}

function boundedText(url: string): Promise<string | null> {
  return textMemo.get(url, () => uncachedBoundedText(url))
}

function sourceMapUrl(scriptUrl: string, script: string): string | null {
  const directive =
    /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^*]+)\*\/)\s*$/u.exec(
      script,
    )
  const value = directive?.[1] ?? directive?.[2]?.trim()
  if (value !== undefined) {
    return value.startsWith('data:') ? value : new URL(value, scriptUrl).href
  }

  const url = new URL(scriptUrl)
  if (!SOURCE_MAP_SUFFIX.test(url.pathname)) return null
  url.pathname = url.pathname.replace(SOURCE_MAP_SUFFIX, '.map')
  return url.href
}

/** True when the path runs through a `node_modules` directory. */
function inDependencies(relative: string): boolean {
  return relative.split('/').includes('node_modules')
}

/**
 * The project-relative path a source name stands for, or null. A file under
 * `node_modules` is never attributed: the baseline ignores that directory, so
 * an edge to it could never select anything.
 */
function sourcePath(
  root: string,
  value: string,
  baseUrl?: string,
): string | null {
  let candidate = value
  let filesystemUrl = false
  try {
    if (value.startsWith('file:')) {
      candidate = fileURLToPath(value)
      filesystemUrl = true
    } else if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
      const url = new URL(value)
      if (url.protocol !== 'webpack:' && url.protocol !== 'vite:') return null
      candidate = decodeURIComponent(url.pathname)
    }
  } catch {
    return null
  }

  candidate = candidate
    .replace(/^webpack:\/\/\/?/u, '')
    .replace(/^vite:\/\/\/?/u, '')
    .replace(/^\/@fs\//u, '/')
    .replace(/[?#].*$/u, '')

  const paths = filesystemUrl
    ? [resolve(candidate)]
    : [
        ...(candidate.startsWith('/') ? [resolve(candidate)] : []),
        resolve(root, candidate.replace(/^[/\\]+/u, '')),
        ...(baseUrl === undefined
          ? []
          : [
              resolve(
                root,
                dirname(new URL(baseUrl).pathname).replace(/^[/\\]+/u, ''),
                candidate,
              ),
            ]),
      ]
  for (const absolute of paths) {
    const relative = projectFile(root, absolute)
    if (
      relative !== null &&
      !inDependencies(relative) &&
      existsSync(absolute)
    ) {
      return relative
    }
  }
  return null
}

async function uncachedSourceMapFiles(
  scriptUrl: string,
  root: string,
): Promise<string[]> {
  const direct = sourcePath(root, new URL(scriptUrl).pathname)
  let script = ''
  let mapUrl = sourceMapUrl(scriptUrl, script)

  if (mapUrl === null || !scriptUrl.includes('.bundle')) {
    script = (await boundedText(scriptUrl)) ?? ''
    mapUrl = sourceMapUrl(scriptUrl, script)
  }

  if (mapUrl === null) return direct === null ? [] : [direct]

  const source = decodedDataUrl(mapUrl) ?? (await boundedText(mapUrl))
  if (source === null) return direct === null ? [] : [direct]

  try {
    const map: unknown = JSON.parse(source)
    const sourceBase = mapUrl.startsWith('data:') ? scriptUrl : mapUrl
    return [
      ...new Set([
        ...(direct === null ? [] : [direct]),
        ...mappedSources(map)
          .map((file) => sourcePath(root, file, sourceBase))
          .filter((file): file is string => file !== null),
      ]),
    ].sort(byCodeUnit)
  } catch {
    return direct === null ? [] : [direct]
  }
}

function lineOffsets(source: string): number[] {
  const offsets = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1)
  }
  return offsets
}

function coverageRanges(
  functions: PlaywrightCoverageFunction[],
): CoverageRange[] {
  return functions
    .flatMap((item) => item.ranges)
    .filter(
      (range) => range.startOffset >= 0 && range.endOffset > range.startOffset,
    )
    .map((range) => ({
      count: range.count,
      end: range.endOffset,
      length: range.endOffset - range.startOffset,
      start: range.startOffset,
    }))
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.length - right.length ||
        left.count - right.count,
    )
}

function executedMappedSources(
  map: string,
  script: string,
  functions: PlaywrightCoverageFunction[],
): string[] {
  const ranges = coverageRanges(functions)
  if (ranges.length === 0) return []

  const offsets = lineOffsets(script)
  const files = new Set<string>()
  const active: CoverageRange[] = []
  let rangeIndex = 0

  eachMapping(new FlattenMap(map), (mapping) => {
    if (mapping.source === null) return
    const lineStart = offsets[mapping.generatedLine - 1]
    if (lineStart === undefined) return
    const offset = lineStart + mapping.generatedColumn
    for (;;) {
      const next = ranges[rangeIndex]
      if (next === undefined || next.start > offset) break
      active.push(next)
      rangeIndex += 1
    }

    let selected: CoverageRange | null = null
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const range = active[index]
      if (range === undefined) continue
      if (range.end <= offset) {
        active.splice(index, 1)
        continue
      }
      if (
        selected === null ||
        range.length < selected.length ||
        (range.length === selected.length && range.count < selected.count)
      ) {
        selected = range
      }
    }
    if (selected !== null && selected.count > 0) files.add(mapping.source)
  })

  return [...files]
}

/**
 * The project files whose original code a script's executed ranges map to.
 * `suppliedScript` is the coverage entry's source; without it the script is
 * fetched. A missing, unfetchable or invalid map leaves only the script's own
 * path, and only when some range ran.
 */
export async function coveredSourceMapFiles(
  scriptUrl: string,
  suppliedScript: string | undefined,
  functions: PlaywrightCoverageFunction[],
  root: string,
): Promise<string[]> {
  const script = suppliedScript ?? (await boundedText(scriptUrl))
  if (script === null) return []
  const direct = sourcePath(root, new URL(scriptUrl).pathname)
  const hasExecutedRange = functions.some((item) =>
    item.ranges.some((range) => range.count > 0),
  )
  const own = direct !== null && hasExecutedRange ? [direct] : []
  const mapUrl = sourceMapUrl(scriptUrl, script)
  if (mapUrl === null) return own
  const source = decodedDataUrl(mapUrl) ?? (await boundedText(mapUrl))
  if (source === null) return own

  try {
    JSON.parse(source)
    const sourceBase = mapUrl.startsWith('data:') ? scriptUrl : mapUrl
    return [
      ...new Set([
        ...own,
        ...executedMappedSources(source, script, functions)
          .map((file) => sourcePath(root, file, sourceBase))
          .filter((file): file is string => file !== null),
      ]),
    ].sort(byCodeUnit)
  } catch {
    return own
  }
}

/** Every project file a script and its source map name, regardless of what ran. */
export function sourceMapFiles(
  scriptUrl: string,
  root: string,
): Promise<string[]> {
  return sourceMapMemo.get(`${root}\0${scriptUrl}`, () =>
    uncachedSourceMapFiles(scriptUrl, root),
  )
}
