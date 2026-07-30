import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { projectRelative } from '../shared/paths.js'

const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024
const SOURCE_MAP_SUFFIX = /(?:\.bundle|\.m?js)$/i

interface SourceMapLike {
  sections?: Array<{ map?: SourceMapLike }>
  sourceRoot?: string
  sources?: string[]
}

const sourceMapCache = new Map<string, Promise<string[]>>()

function mappedSources(map: SourceMapLike): string[] {
  return [
    ...(map.sources ?? []).map((source) =>
      map.sourceRoot === undefined
        ? source
        : `${map.sourceRoot.replace(/\/+$/, '')}/${source.replace(/^\/+/, '')}`,
    ),
    ...(map.sections ?? []).flatMap((section) =>
      section.map === undefined ? [] : mappedSources(section.map),
    ),
  ]
}

function decodedDataUrl(value: string): string | null {
  const match = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(
    value,
  )
  if (match === null) {
    return null
  }

  try {
    return match[1] === undefined
      ? decodeURIComponent(match[2]!)
      : Buffer.from(match[2]!, 'base64').toString('utf8')
  } catch {
    return null
  }
}

async function boundedText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }

    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_SOURCE_MAP_BYTES) {
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

function sourceMapUrl(scriptUrl: string, script: string): string | null {
  const directive =
    /(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^*]+)\*\/)\s*$/.exec(
      script,
    )
  const value = directive?.[1] ?? directive?.[2]?.trim()
  if (value !== undefined) {
    return value.startsWith('data:')
      ? value
      : new URL(value, scriptUrl).href
  }

  const url = new URL(scriptUrl)
  if (!SOURCE_MAP_SUFFIX.test(url.pathname)) {
    return null
  }
  url.pathname = url.pathname.replace(SOURCE_MAP_SUFFIX, '.map')
  return url.href
}

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
    } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      const url = new URL(value)
      if (url.protocol !== 'webpack:' && url.protocol !== 'vite:') {
        return null
      }
      candidate = decodeURIComponent(url.pathname)
    }
  } catch {
    return null
  }

  candidate = candidate
    .replace(/^webpack:\/\/\/?/, '')
    .replace(/^vite:\/\/\/?/, '')
    .replace(/^\/@fs\//, '/')
    .replace(/[?#].*$/, '')

  const paths = filesystemUrl
    ? [resolve(candidate)]
    : [
        ...(candidate.startsWith('/') ? [resolve(candidate)] : []),
        resolve(root, candidate.replace(/^[/\\]+/, '')),
        ...(baseUrl === undefined
          ? []
          : [
              resolve(
                root,
                dirname(new URL(baseUrl).pathname).replace(/^[/\\]+/, ''),
                candidate,
              ),
            ]),
      ]
  for (const absolute of paths) {
    const relative = projectRelative(root, absolute)
    if (
      relative !== null &&
      relative !== '' &&
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

  if (mapUrl === null) {
    return direct === null ? [] : [direct]
  }

  const source =
    decodedDataUrl(mapUrl) ??
    await boundedText(mapUrl)
  if (source === null) {
    return direct === null ? [] : [direct]
  }

  try {
    const map = JSON.parse(source) as SourceMapLike
    const sourceBase = mapUrl.startsWith('data:') ? scriptUrl : mapUrl
    return [
      ...new Set([
        ...(direct === null ? [] : [direct]),
        ...mappedSources(map)
          .map((file) => sourcePath(root, file, sourceBase))
          .filter((file): file is string => file !== null),
      ]),
    ].sort()
  } catch {
    return direct === null ? [] : [direct]
  }
}

export function sourceMapFiles(
  scriptUrl: string,
  root: string,
): Promise<string[]> {
  const key = `${root}\0${scriptUrl}`
  const cached = sourceMapCache.get(key)
  if (cached !== undefined) {
    return cached
  }

  const pending = uncachedSourceMapFiles(scriptUrl, root)
  sourceMapCache.set(key, pending)
  return pending
}
