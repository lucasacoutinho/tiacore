import { relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
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

interface Finished {
  readonly code: number
  readonly output: Buffer
}

/**
 * Asks for the HEAD commit and the repository top in one process. Git prints
 * each answer as soon as it has it and stops at the first failure, so the
 * order of the arguments decides what survives a failure:
 * - `--is-inside-work-tree` never fails inside a repository, and prints
 *   `false` in a bare repository or a git directory, where `--show-toplevel`
 *   dies and HEAD can still resolve;
 * - `--show-toplevel` prints the top before `--verify HEAD` fails on a
 *   repository without commits.
 */
const HEAD_AND_TOP = [
  'rev-parse',
  '--is-inside-work-tree',
  '--show-toplevel',
  '--verify',
  'HEAD',
] as const

/** What `HEAD_AND_TOP` printed. */
type Located =
  | { readonly _tag: 'Born'; readonly sha: string; readonly top: string }
  | { readonly _tag: 'Unborn'; readonly top: string }
  | { readonly _tag: 'NoWorkTree' }
  | { readonly _tag: 'Unavailable' }
  | { readonly _tag: 'Unrecognized' }

function locate(finished: Finished | null): Located {
  if (finished === null) return { _tag: 'Unavailable' }
  const printed = finished.output.toString('utf8')
  const newline = printed.indexOf('\n')
  const first = newline === -1 ? printed : printed.slice(0, newline)
  const rest = newline === -1 ? '' : printed.slice(newline + 1)
  if (first === 'false') return { _tag: 'NoWorkTree' }
  if (first === '') {
    return finished.code === 0
      ? { _tag: 'Unrecognized' }
      : { _tag: 'Unavailable' }
  }
  if (first !== 'true') return { _tag: 'Unrecognized' }
  if (finished.code !== 0) {
    const top = rest.trim()
    return top === '' ? { _tag: 'Unrecognized' } : { _tag: 'Unborn', top }
  }
  // The top may hold a newline; the commit is the last line.
  const body = rest.trimEnd()
  const split = body.lastIndexOf('\n')
  const top = body.slice(0, split).trim()
  const sha = body.slice(split + 1).trim()
  return split === -1 || top === '' || sha === ''
    ? { _tag: 'Unrecognized' }
    : { _tag: 'Born', sha, top }
}

export function makeGit(
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
) {
  /** Runs git and keeps its output whatever the exit code; null when it cannot run at all. */
  const exec = (root: string, args: readonly string[]) =>
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
        return {
          code: Number(code),
          output: Buffer.concat(chunks),
        } satisfies Finished
      }),
    ).pipe(Effect.orElseSucceed(() => null))

  const run = (root: string, args: readonly string[]) =>
    exec(root, args).pipe(
      Effect.map((finished) => (finished?.code === 0 ? finished.output : null)),
    )

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
  // capture and change detection both ask for it, so it is asked once. The
  // question that finds HEAD answers it too, so a capture spends no process
  // on the top: it is only asked on its own when nothing asked for HEAD first.
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
  const learnTop = (root: string, top: string) => {
    if (!topLevels.has(root)) topLevels.set(root, Effect.succeed(top))
  }

  const verifiedHead = (root: string) =>
    text(root, ['rev-parse', '--verify', 'HEAD'])

  // HEAD moves, so it is asked every time.
  const currentSha = (root: string) =>
    exec(root, HEAD_AND_TOP).pipe(
      Effect.flatMap((finished) =>
        Match.valueTags(locate(finished), {
          Born: ({ sha, top }) =>
            Effect.sync(() => {
              learnTop(root, top)
              return sha
            }),
          NoWorkTree: () => verifiedHead(root),
          Unavailable: () => Effect.succeed(null),
          Unborn: ({ top }) =>
            Effect.sync(() => {
              learnTop(root, top)
              return null
            }),
          Unrecognized: () => verifiedHead(root),
        }),
      ),
    )

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
    currentSha,
    repositoryTop,
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
