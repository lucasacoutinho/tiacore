import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { byCodeUnit } from '../../core/canonical.ts'
import type { Baseline } from '../../core/runtime.ts'
import { Baselines } from '../ports.ts'
import { UNAVAILABLE_HASH } from './fingerprint.ts'

// Baseline capture and change detection, independent of where the project
// lives. A `Probe` answers questions about a repository and a working tree;
// the live probe asks git and the file system, the memory probe a plain
// object. Every answer that cannot be had is null, and null propagates: the
// caller then treats change detection as unavailable and runs everything.

const VITE_TEMPORARY_CONFIG =
  /\.config\.[cm]?[jt]s\.timestamp-\d+-[a-z\d]+\.mjs$/iu
const BUN_TEMPORARY_BUILD = /(?:^|\/)\.[a-z\d]+-\d+\.bun-build$/iu

const HASH_CONCURRENCY = 16

export interface Probe {
  readonly currentSha: (root: string) => Effect.Effect<string | null>
  readonly exists: (root: string, file: string) => Effect.Effect<boolean>
  /** Content hash of a project file; see `hashFile` for the sentinel values. */
  readonly hash: (root: string, file: string) => Effect.Effect<string>
  readonly isAncestor: (
    root: string,
    ancestor: string,
    head: string,
  ) => Effect.Effect<boolean>
  /** Files the working tree changes against a revision (renames as delete + add). */
  readonly trackedChanges: (
    root: string,
    revision: string,
  ) => Effect.Effect<string[] | null>
  readonly untracked: (root: string) => Effect.Effect<string[] | null>
  /** Every project file, for projects outside a repository. */
  readonly projectFiles: (
    root: string,
    ignoredPrefixes: readonly string[],
  ) => Effect.Effect<string[] | null>
}

export function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(byCodeUnit)
}

export function isTemporaryToolFile(file: string): boolean {
  return VITE_TEMPORARY_CONFIG.test(file) || BUN_TEMPORARY_BUILD.test(file)
}

/** True when the file is a prefix or lies under one; the empty prefix matches nothing. */
export function isIgnored(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) =>
      prefix !== '' && (file === prefix || file.startsWith(`${prefix}/`)),
  )
}

function recorded(
  sha: string,
  source: 'filesystem' | 'git',
  hashed: ReadonlyMap<string, string>,
): Baseline {
  return { sha, source, workingTree: Object.fromEntries(hashed) }
}

/** Files whose current hash (null when absent) differs from the recorded one. */
function differing(
  baseline: Baseline,
  hashes: ReadonlyMap<string, string | null>,
): string[] {
  const changes: string[] = []
  for (const [file, hash] of hashes) {
    if (baseline.workingTree[file] !== hash) changes.push(file)
  }
  return changes
}

export function makeBaselines(probe: Probe): Baselines['Service'] {
  /** File -> hash for each file, or null when any file cannot be hashed. */
  const hashAll = (root: string, files: readonly string[]) =>
    Effect.forEach(files, (file) => probe.hash(root, file), {
      concurrency: HASH_CONCURRENCY,
    }).pipe(
      Effect.map((hashes) => {
        const hashed = new Map<string, string>()
        for (const [index, file] of files.entries()) {
          const hash = hashes[index]!
          if (hash === UNAVAILABLE_HASH) return null
          hashed.set(file, hash)
        }
        return hashed
      }),
    )

  const filesystemChanges = Effect.fnUntraced(function* (
    root: string,
    baseline: Baseline,
    ignoredPrefixes: readonly string[],
  ) {
    const current = yield* probe.projectFiles(root, ignoredPrefixes)
    if (current === null) return null
    const present = new Set(current)
    const candidates = unique([
      ...Object.keys(baseline.workingTree),
      ...current,
    ])
    const listed = candidates.filter((file) => present.has(file))
    const hashed = yield* hashAll(root, listed)
    if (hashed === null) return null
    const hashes = new Map<string, string | null>()
    for (const file of candidates) hashes.set(file, hashed.get(file) ?? null)
    return differing(baseline, hashes)
  })

  const gitChanges = Effect.fnUntraced(function* (
    root: string,
    baseline: Baseline,
    ignoredPrefixes: readonly string[],
  ) {
    const head = yield* probe.currentSha(root)
    if (head === null) return null
    if (!(yield* probe.isAncestor(root, baseline.sha, head))) return null
    const tracked = yield* probe.trackedChanges(root, baseline.sha)
    const untracked = yield* probe.untracked(root)
    if (tracked === null || untracked === null) return null
    const candidates = unique([
      ...Object.keys(baseline.workingTree),
      ...tracked,
      ...untracked,
    ]).filter(
      (file) => !isIgnored(file, ignoredPrefixes) && !isTemporaryToolFile(file),
    )
    const hashed = yield* hashAll(root, candidates)
    if (hashed === null) return null
    return differing(baseline, hashed)
  })

  const captureFilesystem = Effect.fnUntraced(function* (
    root: string,
    ignoredPrefixes: readonly string[],
  ) {
    const files = yield* probe.projectFiles(root, ignoredPrefixes)
    if (files === null) return null
    const hashed = yield* hashAll(root, files)
    if (hashed === null) return null
    return recorded('', 'filesystem', hashed)
  })

  const captureGit = Effect.fnUntraced(function* (
    root: string,
    sha: string,
    ignoredPrefixes: readonly string[],
  ) {
    const tracked = yield* probe.trackedChanges(root, sha)
    const untracked = yield* probe.untracked(root)
    if (tracked === null || untracked === null) return null
    const trackedSet = new Set(tracked)
    const candidates = unique([...tracked, ...untracked]).filter(
      (file) => !isIgnored(file, ignoredPrefixes),
    )
    // An untracked file that vanished before it could be hashed is skipped;
    // a tracked one that was deleted is recorded as `<deleted>`.
    const present = yield* Effect.forEach(
      candidates,
      (file) =>
        trackedSet.has(file) ? Effect.succeed(true) : probe.exists(root, file),
      { concurrency: HASH_CONCURRENCY },
    )
    const hashed = yield* hashAll(
      root,
      candidates.filter((_, index) => present[index] === true),
    )
    if (hashed === null) return null
    return recorded(sha, 'git', hashed)
  })

  return Baselines.of({
    capture: (root, ignoredPrefixes) =>
      probe
        .currentSha(root)
        .pipe(
          Effect.flatMap((sha) =>
            sha === null
              ? captureFilesystem(root, ignoredPrefixes)
              : captureGit(root, sha, ignoredPrefixes),
          ),
        ),
    changedSince: (root, baseline, ignoredPrefixes) =>
      baseline.source === 'filesystem'
        ? filesystemChanges(root, baseline, ignoredPrefixes)
        : gitChanges(root, baseline, ignoredPrefixes),
    currentSha: probe.currentSha,
    isAncestor: probe.isAncestor,
  })
}

export const baselinesLayer = (probe: Probe): Layer.Layer<Baselines> =>
  Layer.succeed(Baselines, makeBaselines(probe))
