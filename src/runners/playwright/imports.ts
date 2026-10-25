import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

import { init, parse } from 'es-module-lexer'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  DELETED_HASH,
  UNAVAILABLE_HASH,
  hashBytes,
} from '../../engine/baseline/fingerprint.ts'
import { projectRelative } from '../../engine/host-path.ts'

// The 1.x scanner, kept for a file the lexer cannot read. It matches inside
// comments and strings too, which only adds edges.
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu
const REQUIRE_PATTERN = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu
const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
]

function regexSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_PATTERN)].flatMap((match) => {
    const specifier = match[1] ?? match[2]
    return specifier === undefined ? [] : [specifier]
  })
}

/**
 * Every module specifier a source file names: static and dynamic imports,
 * re-exports and `import x = require()` through the lexer, plus `require()`
 * calls, which the lexer does not see. A file the lexer rejects falls back to
 * the 1.x scanner.
 */
function specifiersOf(source: string): string[] {
  let found: string[]
  try {
    const [imports] = parse(source)
    found = imports.flatMap((entry) =>
      typeof entry.specifier === 'string' ? [entry.specifier] : [],
    )
  } catch {
    return regexSpecifiers(source)
  }
  for (const match of source.matchAll(REQUIRE_PATTERN)) {
    if (match[1] !== undefined) found.push(match[1])
  }
  return found
}

function importedSpecifiers(source: string): string[] {
  return specifiersOf(source).filter((specifier) => specifier.startsWith('.'))
}

/**
 * Resolves a relative specifier the way 1.x did, quirks included: a specifier
 * with an extension names exactly that file (`./a.service` and `./x.js` do not
 * try `a.service.ts` or `x.ts`), and a bare name that is a directory resolves
 * to the directory itself before its `index` file is considered.
 */
function resolveImport(importer: string, specifier: string): string | null {
  const candidate = resolve(dirname(importer), specifier)
  const paths =
    extname(candidate) === ''
      ? [
          candidate,
          ...EXTENSIONS.map((extension) => `${candidate}${extension}`),
          ...EXTENSIONS.map((extension) =>
            resolve(candidate, `index${extension}`),
          ),
        ]
      : [candidate]
  return paths.find((path) => existsSync(path)) ?? null
}

function readImports(file: string): string[] {
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return importedSpecifiers(source).flatMap((specifier) => {
    const imported = resolveImport(file, specifier)
    return imported === null ? [] : [imported]
  })
}

/** Resolved relative imports of each file already read, keyed by absolute path. */
export type ImportMemo = Map<string, readonly string[]>

/**
 * Project-relative files reachable from `entry` through relative imports,
 * sorted. Pass one `memo` to several calls of a run so a helper that many
 * specs import is read and lexed once; a memo is valid only while the files
 * stay as they are.
 */
export async function importedProjectFiles(
  entry: string,
  root: string,
  memo: ImportMemo = new Map(),
): Promise<string[]> {
  await init
  const pending = [resolve(entry)]
  const visited = new Set<string>()
  const files = new Set<string>()

  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || visited.has(file)) continue
    visited.add(file)

    const relative = projectRelative(root, file)
    if (relative === null || relative === '') continue
    files.add(relative)

    let imports = memo.get(file)
    if (imports === undefined) {
      imports = readImports(file)
      memo.set(file, imports)
    }
    pending.push(...imports)
  }

  return [...files].sort(byCodeUnit)
}

function hashFileSync(path: string): string {
  if (!existsSync(path)) return DELETED_HASH
  try {
    return hashBytes(readFileSync(path))
  } catch (error) {
    return error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
      ? DELETED_HASH
      : UNAVAILABLE_HASH
  }
}

/** Digest of the entry's import closure: each file's path and content hash. */
export async function importedFilesFingerprint(
  entry: string,
  root: string,
): Promise<string> {
  const files = await importedProjectFiles(entry, root)
  return hashBytes(
    JSON.stringify(
      files.map((file) => [file, hashFileSync(resolve(root, file))]),
    ),
  )
}
