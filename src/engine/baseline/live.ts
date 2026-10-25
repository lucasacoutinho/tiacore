import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { ChildProcessSpawner } from 'effect/process'

import { Baselines } from '../ports.ts'
import {
  isIgnored,
  isTemporaryToolFile,
  makeBaselines,
  unique,
} from './algorithm.ts'
import { hashFile } from './fingerprint.ts'
import { makeGit } from './git.ts'
import { walkProjectFiles } from './walk.ts'

/** Baselines from git when the project is in a repository, else from a file snapshot. */
export const BaselinesLive = Layer.effect(
  Baselines,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const vcs = makeGit(yield* ChildProcessSpawner.ChildProcessSpawner)

    return makeBaselines({
      currentSha: vcs.currentSha,
      exists: (root, file) =>
        fs.exists(resolve(root, file)).pipe(Effect.orElseSucceed(() => false)),
      hash: (root, file) => hashFile(fs, resolve(root, file)),
      isAncestor: vcs.isAncestor,
      projectFiles: (root, ignoredPrefixes) =>
        vcs
          .paths(root, [
            'ls-files',
            '-z',
            '--cached',
            '--others',
            '--exclude-standard',
          ])
          .pipe(
            Effect.flatMap((listed) =>
              listed === null
                ? walkProjectFiles(fs, root, ignoredPrefixes).pipe(
                    Effect.map(
                      (walked) =>
                        walked?.filter((file) => !isTemporaryToolFile(file)) ??
                        null,
                    ),
                  )
                : Effect.succeed(
                    unique(listed).filter(
                      (file) =>
                        !isIgnored(file, ignoredPrefixes) &&
                        !isTemporaryToolFile(file),
                    ),
                  ),
            ),
          ),
      trackedChanges: vcs.trackedChanges,
      untracked: vcs.untracked,
    })
  }),
)
