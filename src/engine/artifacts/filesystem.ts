import { dirname, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'

import {
  MAX_ARTIFACT_ARCHIVE_BYTES,
  type TiaArtifactCandidate,
  type TiaArtifactProvider,
  type TiaArtifactProviderContext,
  type TiaFilesystemArtifactOptions,
} from '../../core/artifacts.ts'
import { byCodeUnit } from '../../core/canonical.ts'
import { runPromise } from '../../host/runtime.ts'
import { GraphStore } from '../ports.ts'
import { GraphStoreLive } from '../state/graph-store.ts'
import { readArtifactArchive } from './archive.ts'

const DEFAULT_PATHS = ['.tia-artifacts']
const MAX_FILES = 1_000

/** Collects archives and graph stores under `path`, skipping symbolic links. */
const artifactFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: string,
  files: string[],
): Effect.fn.Return<void> {
  if (files.length >= MAX_FILES) return

  const info = yield* fs.lstat(path).pipe(Effect.option)
  if (Option.isNone(info)) return
  if (info.value.type === 'File') {
    if (
      (path.endsWith('state.json') || path.endsWith('.zip')) &&
      Number(info.value.size) <= MAX_ARTIFACT_ARCHIVE_BYTES
    ) {
      files.push(path)
    }
    return
  }
  if (info.value.type !== 'Directory') return

  const names = yield* fs
    .readDirectory(path)
    .pipe(Effect.orElseSucceed(() => []))
  for (const name of names.sort(byCodeUnit)) {
    yield* artifactFiles(fs, resolve(path, name), files)
    if (files.length >= MAX_FILES) return
  }
})

const candidateAt = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: string,
  context: TiaArtifactProviderContext,
  options: TiaFilesystemArtifactOptions,
) {
  const store = yield* GraphStore
  const isArchive = path.endsWith('.zip')
  const archived = isArchive
    ? readArtifactArchive(yield* fs.readFile(path), context.runner)
    : null
  if (isArchive && archived === null) return []
  const graph = archived?.graph ?? (yield* store.read(dirname(path))).graph
  if (graph === null) return []
  const group =
    typeof graph.partition?.group === 'string'
      ? graph.partition.group
      : options.group
  const candidate: TiaArtifactCandidate = {
    ...(archived?.attestation === undefined
      ? {}
      : { attestation: archived.attestation }),
    graph,
    ...(archived === null ? {} : { graphSha256: archived.graphSha256 }),
    ...(group === undefined ? {} : { group }),
    id: path,
  }
  return [candidate]
})

export const loadFilesystemArtifacts = Effect.fnUntraced(function* (
  context: TiaArtifactProviderContext,
  options: TiaFilesystemArtifactOptions,
) {
  const fs = yield* FileSystem.FileSystem
  const root = context.root ?? process.cwd()
  const files: string[] = []
  for (const path of options.paths ?? DEFAULT_PATHS) {
    yield* artifactFiles(fs, resolve(root, path), files)
  }

  const candidates: TiaArtifactCandidate[] = []
  for (const path of files) {
    // One unreadable file never hides the others.
    candidates.push(
      ...(yield* candidateAt(fs, path, context, options).pipe(
        Effect.orElseSucceed((): TiaArtifactCandidate[] => []),
      )),
    )
  }
  return candidates
})

export function createFilesystemArtifactProvider(
  options: TiaFilesystemArtifactOptions = {},
): TiaArtifactProvider {
  return {
    name: 'filesystem artifacts',
    load: (context) =>
      runPromise(
        loadFilesystemArtifacts(context, options).pipe(
          Effect.provide(GraphStoreLive),
        ),
      ),
  }
}
