import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import * as Semaphore from 'effect/Semaphore'

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
export const WALK_CONCURRENCY = 8

interface IgnoreRule {
  readonly ignored: boolean
  /** Whether the rule matches `path`, which names a directory when `directory` is true. */
  readonly matches: (path: string, directory: boolean) => boolean
}

function parseIgnoreRules(source: string): IgnoreRule[] {
  return source.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return []

    const ignored = !trimmed.startsWith('!')
    const original = ignored ? trimmed : trimmed.slice(1)
    const anchored = original.startsWith('/')
    const directoryOnly = original.endsWith('/')
    const pattern = original.replace(/^\/+/u, '').replace(/\/+$/u, '')
    if (pattern === '') return []

    const rooted = anchored || pattern.includes('/')
    const named = globMatcher(rooted ? [pattern] : [pattern, `**/${pattern}`])
    if (!directoryOnly) return [{ ignored, matches: (path) => named(path) }]
    // As in git, `name/` matches a directory called `name` and everything
    // under one, never a file called `name`. (`name/**` would match the
    // bare name too, hence `name/**/*`.)
    const below = globMatcher(
      rooted ? [`${pattern}/**/*`] : [`${pattern}/**/*`, `**/${pattern}/**/*`],
    )
    return [
      {
        ignored,
        matches: (path, directory) => (directory && named(path)) || below(path),
      },
    ]
  })
}

function ignoredByRules(
  file: string,
  directory: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.matches(file, directory)) ignored = rule.ignored
  }
  return ignored
}

const isNotFound = (error: PlatformError) => error.reason._tag === 'NotFound'

/**
 * Every regular project file under `root`, sorted, or null when a read fails.
 * An entry deleted while the walk runs is skipped; a missing root fails.
 */
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
    // Every directory visits its subdirectories concurrently, so one budget
    // bounds the file system calls in flight across the whole tree. Only the
    // calls hold a permit; a visit waiting on its subdirectories holds none.
    const permits = yield* Semaphore.make(WALK_CONCURRENCY)
    const files: string[] = []

    const visit = (
      directory: string,
      prefix: string,
    ): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        const names = yield* permits
          .withPermit(fs.readDirectory(directory))
          .pipe(
            Effect.catchIf(
              (error) => prefix !== '' && isNotFound(error),
              () => Effect.succeed<string[]>([]),
            ),
          )
        const entries = yield* Effect.forEach(
          names.filter((name) => {
            const file = prefix === '' ? name : `${prefix}/${name}`
            return !isIgnored(file, ignoredPrefixes)
          }),
          (name) =>
            permits.withPermit(fs.lstat(resolve(directory, name))).pipe(
              Effect.map((info) => ({ info, name })),
              Effect.catchIf(isNotFound, () => Effect.succeed(null)),
            ),
          { concurrency: WALK_CONCURRENCY },
        )
        const subdirectories: Array<[string, string]> = []
        for (const entry of entries) {
          if (entry === null) continue
          const { info, name } = entry
          const file = prefix === '' ? name : `${prefix}/${name}`
          if (info.type === 'Directory') {
            if (
              ALWAYS_IGNORED_DIRECTORIES.has(name) ||
              (prefix === '' && ROOT_OUTPUT_DIRECTORIES.has(name)) ||
              ignoredByRules(file, true, rules)
            ) {
              continue
            }
            subdirectories.push([resolve(directory, name), file])
          } else if (
            info.type === 'File' &&
            !ignoredByRules(file, false, rules)
          ) {
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
