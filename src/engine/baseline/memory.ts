import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { Baselines } from '../ports.ts'
import {
  isIgnored,
  isTemporaryToolFile,
  makeBaselines,
  unique,
  type Probe,
} from './algorithm.ts'
import { DELETED_HASH } from './fingerprint.ts'

/**
 * A project held in memory. History is linear, oldest commit first; HEAD is
 * the last commit. A project without commits behaves like a directory outside
 * a repository. `files` maps each file in the working tree to its content hash
 * (use `<unavailable>` to model an unreadable file). Plain objects, so a test
 * can edit the working tree between calls.
 */
export interface MemoryProject {
  readonly commits: ReadonlyArray<{
    readonly files: Readonly<Record<string, string>>
    readonly sha: string
  }>
  files: Record<string, string>
  /** Untracked files that are not ignored; the rest of `files` is tracked. */
  untracked?: readonly string[]
}

function filesAt(project: MemoryProject, sha: string) {
  return project.commits.find((commit) => commit.sha === sha)?.files
}

function memoryProbe(projects: ReadonlyMap<string, MemoryProject>): Probe {
  const lookup = (root: string): MemoryProject =>
    projects.get(root) ?? { commits: [], files: {} }
  const head = (root: string): string | null =>
    lookup(root).commits.at(-1)?.sha ?? null
  return {
    currentSha: (root) => Effect.sync(() => head(root)),
    exists: (root, file) =>
      Effect.sync(() => lookup(root).files[file] !== undefined),
    hash: (root, file) =>
      Effect.sync(() => lookup(root).files[file] ?? DELETED_HASH),
    isAncestor: (root, ancestor, descendant) =>
      Effect.sync(() => {
        const commits = lookup(root).commits.map(({ sha }) => sha)
        const from = commits.indexOf(ancestor)
        const to = commits.indexOf(descendant)
        return from !== -1 && to !== -1 && from <= to
      }),
    projectFiles: (root, ignoredPrefixes) =>
      Effect.sync(() => {
        return unique(Object.keys(lookup(root).files)).filter(
          (file) =>
            !isIgnored(file, ignoredPrefixes) && !isTemporaryToolFile(file),
        )
      }),
    trackedChanges: (root, revision) =>
      Effect.sync(() => {
        const project = lookup(root)
        const before = filesAt(project, revision)
        if (before === undefined) return null
        const untracked = new Set(project.untracked ?? [])
        const tracked = Object.keys(project.files).filter(
          (file) => !untracked.has(file),
        )
        return unique(
          [...new Set([...Object.keys(before), ...tracked])].filter(
            (file) =>
              before[file] !== project.files[file] && !untracked.has(file),
          ),
        )
      }),
    untracked: (root) =>
      Effect.sync(() => unique(lookup(root).untracked ?? [])),
  }
}

/** Baselines over in-memory projects, keyed by root, for tests and isolated runs. */
export const baselinesMemory = (
  projects: ReadonlyMap<string, MemoryProject>,
): Layer.Layer<Baselines> =>
  Layer.succeed(Baselines, makeBaselines(memoryProbe(projects)))

/** Baselines over no projects: every root is outside a repository and empty. */
export const BaselinesMemory: Layer.Layer<Baselines> = baselinesMemory(
  new Map(),
)
