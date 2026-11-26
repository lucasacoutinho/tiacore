import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { init, parse } from 'es-module-lexer'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  DELETED_HASH,
  UNAVAILABLE_HASH,
  hashBytes,
} from '../../engine/baseline/fingerprint.ts'
import { projectFile } from '../../engine/host-path.ts'

// The 1.x scanner, kept for a file the lexer cannot read. It matches inside
// comments and strings too, which only adds edges.
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu
const REQUIRE_PATTERN = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu
/**
 * The extensions Playwright's TypeScript loader tries for a path that names no
 * file (`kExtLookups` in playwright/lib/util.js), in its order. Only the first
 * entry whose suffix the path ends with is tried: `./x.js` may name `x.ts`,
 * and any other path, `./auth.helper` included, gets each extension appended.
 * `.json` comes last, where Node's own lookup finds it once the loader gives up.
 */
const EXTENSION_LOOKUPS: ReadonlyArray<
  readonly [suffix: string, replacements: readonly string[]]
> = [
  ['.js', ['.jsx', '.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.cjs', ['.cts']],
  ['.mjs', ['.mts']],
  ['', ['.js', '.ts', '.jsx', '.tsx', '.cjs', '.mjs', '.cts', '.mts', '.json']],
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

function entryKind(path: string): 'directory' | 'file' | null {
  try {
    const entry = statSync(path, { throwIfNoEntry: false })
    if (entry?.isFile() === true) return 'file'
    return entry?.isDirectory() === true ? 'directory' : null
  } catch {
    return null
  }
}

/** The file a path names exactly, or after the loader's extension lookup. */
function withExtension(path: string): string | null {
  if (entryKind(path) === 'file') return path
  const lookup = EXTENSION_LOOKUPS.find(([suffix]) => path.endsWith(suffix))
  if (lookup === undefined) return null
  const [suffix, replacements] = lookup
  const stem = path.slice(0, path.length - suffix.length)
  for (const replacement of replacements) {
    const candidate = `${stem}${replacement}`
    if (entryKind(candidate) === 'file') return candidate
  }
  return null
}

/** The file a directory's package.json `main` names, or null. */
function packageMain(directory: string): string | null {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  return typeof manifest === 'object' &&
    manifest !== null &&
    'main' in manifest &&
    typeof manifest.main === 'string' &&
    manifest.main !== ''
    ? withExtension(resolve(directory, manifest.main))
    : null
}

/**
 * Resolves a relative specifier as Playwright's TypeScript loader does
 * (`resolveImportSpecifierAfterMapping`): the exact file, then the extension
 * lookup, then, for a directory, the file its package.json `main` names or
 * its `index` file.
 */
function resolveImport(importer: string, specifier: string): string | null {
  const candidate = resolve(dirname(importer), specifier)
  const file = withExtension(candidate)
  if (file !== null || entryKind(candidate) !== 'directory') return file
  return packageMain(candidate) ?? withExtension(join(candidate, 'index'))
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

    const relative = projectFile(root, file)
    if (relative === null) continue
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
