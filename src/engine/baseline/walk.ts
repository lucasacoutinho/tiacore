import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { globMatcher } from '../glob.ts'
import { slash } from '../host-path.ts'
import { isIgnored, unique } from './algorithm.ts'

// The fallback file listing for projects outside a git repository. It reads
// only <root>/.gitignore (nested ignore files, .git/info/exclude and global
// excludes are not consulted) and records regular files only: symlinks and
// empty directories never enter a filesystem baseline.

const ALWAYS_IGNORED_DIRECTORIES = new Set(['.git', '.tia', 'node_modules'])
const ROOT_OUTPUT_DIRECTORIES = new Set([
  '.cache',
  '.turbo',
  'build',
  'coverage',
  'dist',
])
const WALK_CONCURRENCY = 8

interface IgnoreRule {
  readonly ignored: boolean
  readonly matcher: (path: string) => boolean
}

function parseIgnoreRules(source: string): IgnoreRule[] {
  return source.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return []

    const ignored = !trimmed.startsWith('!')
    const original = ignored ? trimmed : trimmed.slice(1)
    const anchored = original.startsWith('/')
    const directory = original.endsWith('/')
    const pattern = original.replace(/^\/+/u, '').replace(/\/+$/u, '')
    if (pattern === '') return []

    const rooted = anchored || pattern.includes('/')
    const variants = rooted ? [pattern] : [pattern, `**/${pattern}`]
    if (directory) {
      variants.push(`${pattern}/**`, ...(rooted ? [] : [`**/${pattern}/**`]))
    }
    return [{ ignored, matcher: globMatcher(variants) }]
  })
}

function ignoredByRules(file: string, rules: readonly IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.matcher(file)) ignored = rule.ignored
  }
  return ignored
}

/** Every regular project file under `root`, sorted, or null when a read fails. */
export const walkProjectFiles = (
  fs: FileSystem.FileSystem,
  root: string,
  ignoredPrefixes: readonly string[],
) =>
  Effect.gen(function* () {
    const rules = yield* fs.readFileString(resolve(root, '.gitignore')).pipe(
      Effect.map(parseIgnoreRules),
      Effect.orElseSucceed((): IgnoreRule[] => []),
    )
    const files: string[] = []

    const visit = (
      directory: string,
      prefix: string,
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(directory)
        const entries = yield* Effect.forEach(
          names.filter((name) => {
            const file = prefix === '' ? name : `${prefix}/${name}`
            return !isIgnored(file, ignoredPrefixes)
          }),
          (name) =>
            fs
              .lstat(resolve(directory, name))
              .pipe(Effect.map((info) => ({ info, name }))),
          { concurrency: WALK_CONCURRENCY },
        )
        const subdirectories: Array<[string, string]> = []
        for (const { info, name } of entries) {
          const file = prefix === '' ? name : `${prefix}/${name}`
          if (info.type === 'Directory') {
            if (
              ALWAYS_IGNORED_DIRECTORIES.has(name) ||
              (prefix === '' && ROOT_OUTPUT_DIRECTORIES.has(name)) ||
              ignoredByRules(file, rules)
            ) {
              continue
            }
            subdirectories.push([resolve(directory, name), file])
          } else if (info.type === 'File' && !ignoredByRules(file, rules)) {
            files.push(slash(file))
          }
        }
        yield* Effect.forEach(
          subdirectories,
          ([path, file]) => visit(path, file),
          { concurrency: WALK_CONCURRENCY, discard: true },
        )
      })

    yield* visit(root, '')
    return unique(files)
  }).pipe(Effect.orElseSucceed(() => null))
