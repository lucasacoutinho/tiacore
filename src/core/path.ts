// Implements proofs/Tia/Path.lean `normalize` over segments, plus the string checks the
// model leaves to the shell.

const MAX_PATH_LENGTH = 4096

export type PathRejection =
  | 'absolute'
  | 'empty'
  | 'escape'
  | 'nul'
  | 'too-long'
  | 'uri'

export type NormalizedPath =
  | { readonly _tag: 'Accepted'; readonly path: string }
  | { readonly _tag: 'Rejected'; readonly reason: PathRejection }

function isSchemeStart(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
}

function isSchemeChar(code: number): boolean {
  return (
    isSchemeStart(code) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 45 ||
    code === 46
  )
}

function hasScheme(segment: string): boolean {
  const colon = segment.indexOf(':')
  if (colon < 1 || !isSchemeStart(segment.charCodeAt(0))) return false
  for (let index = 1; index < colon; index += 1) {
    if (!isSchemeChar(segment.charCodeAt(index))) return false
  }
  return true
}

/** True when every segment is a real name, so normalization returns the input. */
function isCanonical(value: string): boolean {
  let segmentStart = 0
  for (let index = 0; index <= value.length; index += 1) {
    const code = index === value.length ? 47 : value.charCodeAt(index)
    if (code === 92 || code === 0) return false
    if (code !== 47) continue
    const length = index - segmentStart
    if (length === 0) return false
    if (value.charCodeAt(segmentStart) === 46) {
      if (length === 1) return false
      if (length === 2 && value.charCodeAt(segmentStart + 1) === 46)
        return false
    }
    segmentStart = index + 1
  }
  return true
}

/** Normalizes a project-relative path to `/`-separated canonical form. */
export function normalizePath(value: string): NormalizedPath {
  if (value.length <= MAX_PATH_LENGTH && isCanonical(value)) {
    const slash = value.indexOf('/')
    if (!hasScheme(slash === -1 ? value : value.slice(0, slash))) {
      return { _tag: 'Accepted', path: value }
    }
  }
  if (value.includes('\0')) return { _tag: 'Rejected', reason: 'nul' }
  if (value.length > MAX_PATH_LENGTH) {
    return { _tag: 'Rejected', reason: 'too-long' }
  }
  const slashed = value.replaceAll('\\', '/')
  if (slashed.startsWith('/')) return { _tag: 'Rejected', reason: 'absolute' }

  const kept: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.pop() === undefined) {
        return { _tag: 'Rejected', reason: 'escape' }
      }
      continue
    }
    kept.push(segment)
  }
  const first = kept[0]
  if (first === undefined) return { _tag: 'Rejected', reason: 'empty' }
  if (hasScheme(first)) return { _tag: 'Rejected', reason: 'uri' }
  return { _tag: 'Accepted', path: kept.join('/') }
}
