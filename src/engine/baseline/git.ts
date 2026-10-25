import { relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { slash } from '../host-path.ts'

// Git through Effect's ChildProcessSpawner. Every call is `git -c
// core.quotepath=false <args>` in `root` with stdin and stderr ignored. A
// non-zero exit, a missing git, a missing directory or output beyond 20 MiB
// all yield null; callers treat null as "change detection unavailable".

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024

class OutputTooLarge {
  readonly _tag = 'OutputTooLarge'
}

export function makeGit(
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
) {
  const run = (root: string, args: readonly string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make('git', ['-c', 'core.quotepath=false', ...args], {
            cwd: root,
            stderr: 'ignore',
            stdin: 'ignore',
          }),
        )
        const chunks: Uint8Array[] = []
        let size = 0
        yield* handle.stdout.pipe(
          Stream.runForEach((chunk) => {
            size += chunk.byteLength
            if (size > MAX_OUTPUT_BYTES)
              return Effect.fail(new OutputTooLarge())
            chunks.push(chunk)
            return Effect.void
          }),
        )
        const code = yield* handle.exitCode
        return Number(code) === 0 ? Buffer.concat(chunks) : null
      }),
    ).pipe(Effect.orElseSucceed(() => null))

  const text = (root: string, args: readonly string[]) =>
    run(root, args).pipe(
      Effect.map((output) => output?.toString('utf8').trim() ?? null),
    )

  const paths = (root: string, args: readonly string[]) =>
    run(root, args).pipe(
      Effect.map(
        (output) =>
          output
            ?.toString('utf8')
            .split('\0')
            .filter((entry) => entry !== '')
            .map(slash) ?? null,
      ),
    )

  // A directory's repository top does not change while tiacore runs, and
  // capture and change detection both ask for it, so it is asked once.
  const topLevels = new Map<string, Effect.Effect<string | null>>()
  const repositoryTop = (root: string) => {
    let top = topLevels.get(root)
    if (top === undefined) {
      top = Effect.runSync(
        Effect.cached(text(root, ['rev-parse', '--show-toplevel'])),
      )
      topLevels.set(root, top)
    }
    return top
  }

  /** Listings run at the repository top and come back relative to `root`. */
  const repositoryPaths = Effect.fnUntraced(function* (
    root: string,
    args: readonly string[],
  ) {
    const repositoryRoot = yield* repositoryTop(root)
    if (repositoryRoot === null) return null
    const listed = yield* paths(repositoryRoot, args)
    return (
      listed?.map((file) =>
        slash(relative(root, resolve(repositoryRoot, file))),
      ) ?? null
    )
  })

  return {
    currentSha: (root: string) => text(root, ['rev-parse', '--verify', 'HEAD']),
    isAncestor: (root: string, ancestor: string, descendant: string) =>
      run(root, ['merge-base', '--is-ancestor', ancestor, descendant]).pipe(
        Effect.map((output) => output !== null),
      ),
    paths,
    trackedChanges: (root: string, revision: string) =>
      repositoryPaths(root, [
        'diff',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACDMRTUXB',
        '-z',
        revision,
        '--',
      ]),
    untracked: (root: string) =>
      repositoryPaths(root, [
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
      ]),
  }
}
