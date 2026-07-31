import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { relative, resolve } from 'node:path'

import picomatch from 'picomatch'

import { slash } from '../../shared/paths.js'
import type { Baseline } from '../types.js'
import {
  hashFile,
  UNAVAILABLE_HASH,
} from './fingerprint.js'

const ALWAYS_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.tia',
  'node_modules',
])

const ROOT_OUTPUT_DIRECTORIES = new Set([
  '.cache',
  '.turbo',
  'build',
  'coverage',
  'dist',
])

const VITE_TEMPORARY_CONFIG =
  /\.config\.[cm]?[jt]s\.timestamp-\d+-[a-z\d]+\.mjs$/i
const BUN_TEMPORARY_BUILD =
  /(?:^|\/)\.[a-z\d]+-\d+\.bun-build$/i

interface IgnoreRule {
  ignored: boolean
  matcher: picomatch.Matcher
}

function runGit(root: string, args: string[]): Buffer | null {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function gitText(root: string, args: string[]): string | null {
  const value = runGit(root, args)
  return value === null ? null : value.toString('utf8').trim()
}

function gitPaths(root: string, args: string[]): string[] | null {
  const value = runGit(root, args)

  if (value === null) {
    return null
  }

  return value
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(slash)
}

function repositoryPaths(root: string, args: string[]): string[] | null {
  const repositoryRoot = gitText(root, ['rev-parse', '--show-toplevel'])
  if (repositoryRoot === null) {
    return null
  }

  const paths = gitPaths(repositoryRoot, args)
  return paths?.map((file) =>
    slash(relative(root, resolve(repositoryRoot, file))),
  ) ?? null
}

export function currentSha(root: string): string | null {
  return gitText(root, ['rev-parse', '--verify', 'HEAD'])
}

export function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): boolean {
  return runGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]) !== null
}

function untrackedFiles(root: string): string[] | null {
  return repositoryPaths(root, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  ])
}

function filesDifferentFrom(root: string, revision: string): string[] | null {
  return repositoryPaths(root, [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACDMRTUXB',
    '-z',
    revision,
    '--',
  ])
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)].sort()
}

function isTemporaryToolFile(file: string): boolean {
  return (
    VITE_TEMPORARY_CONFIG.test(file) ||
    BUN_TEMPORARY_BUILD.test(file)
  )
}

function isIgnored(file: string, prefixes: string | string[]): boolean {
  return (Array.isArray(prefixes) ? prefixes : [prefixes]).some(
    (prefix) =>
      prefix !== '' &&
      (file === prefix || file.startsWith(`${prefix}/`)),
  )
}

function ignoreRules(root: string): IgnoreRule[] {
  try {
    return readFileSync(resolve(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) {
          return []
        }

        const ignored = !trimmed.startsWith('!')
        const original = ignored ? trimmed : trimmed.slice(1)
        const anchored = original.startsWith('/')
        const directory = original.endsWith('/')
        const pattern = original
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
        if (pattern === '') {
          return []
        }

        const variants =
          anchored || pattern.includes('/')
            ? [pattern]
            : [pattern, `**/${pattern}`]
        if (directory) {
          variants.push(
            `${pattern}/**`,
            ...(anchored || pattern.includes('/')
              ? []
              : [`**/${pattern}/**`]),
          )
        }

        return [{
          ignored,
          matcher: picomatch(variants, { dot: true }),
        }]
      })
  } catch {
    return []
  }
}

function ignoredByRules(
  file: string,
  rules: IgnoreRule[],
): boolean {
  let ignored = false
  for (const rule of rules) {
    if (rule.matcher(file)) {
      ignored = rule.ignored
    }
  }
  return ignored
}

function walkProjectFiles(
  root: string,
  ignoredPrefixes: string | string[],
): string[] | null {
  const files: string[] = []
  const rules = ignoreRules(root)

  function visit(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (isIgnored(file, ignoredPrefixes)) {
        continue
      }

      if (entry.isDirectory()) {
        if (
          ALWAYS_IGNORED_DIRECTORIES.has(entry.name) ||
          (prefix === '' && ROOT_OUTPUT_DIRECTORIES.has(entry.name)) ||
          ignoredByRules(file, rules)
        ) {
          continue
        }
        visit(resolve(directory, entry.name), file)
      } else if (entry.isFile() && !ignoredByRules(file, rules)) {
        files.push(slash(file))
      }
    }
  }

  try {
    visit(root, '')
    return unique(files)
  } catch {
    return null
  }
}

function projectFiles(
  root: string,
  ignoredPrefixes: string | string[],
): string[] | null {
  const listed = gitPaths(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])

  return listed === null
    ? walkProjectFiles(root, ignoredPrefixes)?.filter(
        (file) => !isTemporaryToolFile(file),
      ) ?? null
    : unique(listed).filter(
        (file) =>
          !isIgnored(file, ignoredPrefixes) &&
          !isTemporaryToolFile(file),
      )
}

function filesystemChanges(
  root: string,
  baseline: Baseline,
  ignoredPrefixes: string | string[],
): string[] | null {
  const current = projectFiles(root, ignoredPrefixes)
  if (current === null) {
    return null
  }

  const candidates = unique([
    ...Object.keys(baseline.workingTree),
    ...current,
  ])
  const currentFiles = new Set(current)

  const changes: string[] = []
  for (const file of candidates) {
    const hash = currentFiles.has(file)
      ? hashFile(resolve(root, file))
      : null
    if (hash === UNAVAILABLE_HASH) {
      return null
    }
    if (baseline.workingTree[file] !== hash) {
      changes.push(file)
    }
  }
  return changes
}

export function changedFilesSince(
  root: string,
  baseline: Baseline,
  ignoredPrefixes: string | string[],
): string[] | null {
  if (baseline.source === 'filesystem') {
    return filesystemChanges(root, baseline, ignoredPrefixes)
  }

  const head = currentSha(root)

  if (head === null || !isAncestor(root, baseline.sha, head)) {
    return null
  }

  const tracked = filesDifferentFrom(root, baseline.sha)
  const untracked = untrackedFiles(root)

  if (tracked === null || untracked === null) {
    return null
  }

  const candidates = unique([
    ...Object.keys(baseline.workingTree),
    ...tracked,
    ...untracked,
  ])
    .filter((file) => !isIgnored(file, ignoredPrefixes))
    .filter((file) => !isTemporaryToolFile(file))
  const changes: string[] = []
  for (const file of candidates) {
    const hash = hashFile(resolve(root, file))
    if (hash === UNAVAILABLE_HASH) {
      return null
    }
    if (baseline.workingTree[file] !== hash) {
      changes.push(file)
    }
  }
  return changes
}

export function captureBaseline(
  root: string,
  ignoredPrefixes: string | string[],
): Baseline | null {
  const sha = currentSha(root)

  if (sha === null) {
    const files = projectFiles(root, ignoredPrefixes)
    if (files === null) {
      return null
    }

    const workingTree: Record<string, string> = {}
    for (const file of files) {
      const hash = hashFile(resolve(root, file))
      if (hash === UNAVAILABLE_HASH) {
        return null
      }
      workingTree[file] = hash
    }
    return { sha: '', source: 'filesystem', workingTree }
  }

  const tracked = filesDifferentFrom(root, sha)
  const untracked = untrackedFiles(root)

  if (tracked === null || untracked === null) {
    return null
  }

  const workingTree: Record<string, string> = {}

  for (const file of unique([...tracked, ...untracked])) {
    if (isIgnored(file, ignoredPrefixes)) {
      continue
    }

    const absolute = resolve(root, file)
    if (existsSync(absolute) || tracked.includes(file)) {
      const hash = hashFile(absolute)
      if (hash === UNAVAILABLE_HASH) {
        return null
      }
      workingTree[file] = hash
    }
  }

  return { sha, source: 'git', workingTree }
}
