import { basename, join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import { afterEach, describe, expect, test } from 'vitest'

import {
  WALK_CONCURRENCY,
  walkProjectFiles,
} from '../../../src/engine/baseline/walk.ts'
import { cleanupScratch, init, put, scratch, vcs } from '../support/repos.ts'

// The file listing for projects outside git, on real scratch directories. A
// test changes what the walk sees by wrapping the file system it is given.

type Wrap = (fs: FileSystem.FileSystem) => FileSystem.FileSystem

const walk = (root: string, wrap: Wrap = (fs) => fs) =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      walkProjectFiles(wrap(fs), root, []),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

const failure = (
  tag: PlatformError.SystemErrorTag,
  method: string,
  path: string,
) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: tag,
      method,
      module: 'FileSystem',
      pathOrDescriptor: path,
    }),
  )

/** Fails each call with `tag` for the entries named in its list. */
const failing =
  (
    tag: PlatformError.SystemErrorTag,
    names: {
      readonly lstat?: readonly string[]
      readonly readDirectory?: readonly string[]
    },
  ): Wrap =>
  (fs) => ({
    ...fs,
    lstat: (path) =>
      names.lstat?.includes(basename(path)) === true
        ? failure(tag, 'lstat', path)
        : fs.lstat(path),
    readDirectory: (path, options) =>
      names.readDirectory?.includes(basename(path)) === true
        ? failure(tag, 'readDirectory', path)
        : fs.readDirectory(path, options),
  })

afterEach(cleanupScratch)

/** `width` directories per level, `depth` levels, one file in each directory. */
function tree(root: string, depth: number, width: number): string[] {
  const files: string[] = []
  const fill = (prefix: string, level: number) => {
    const file = prefix === '' ? 'f.ts' : `${prefix}/f.ts`
    put(root, file)
    files.push(file)
    if (level === depth) return
    for (let index = 0; index < width; index += 1) {
      fill(prefix === '' ? `d${index}` : `${prefix}/d${index}`, level + 1)
    }
  }
  fill('', 0)
  return files
}

describe('ignore rules', () => {
  test('a directory-only rule ignores directories of that name, never a file, as git does', async () => {
    const root = scratch()
    put(root, '.gitignore', 'out/\n/gen/\n')
    put(root, 'out')
    put(root, 'src/out')
    put(root, 'lib/out/x.ts')
    put(root, 'gen')
    put(root, 'src/gen/y.ts')
    put(root, 'src/a.ts')
    const expected = [
      '.gitignore',
      'gen',
      'out',
      'src/a.ts',
      'src/gen/y.ts',
      'src/out',
    ]
    expect(await walk(root)).toEqual(expected)

    init(root)
    const listed = vcs(
      root,
      '-c',
      'core.excludesFile=/dev/null',
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
    )
    expect(listed.split('\0').filter((file) => file !== '')).toEqual(expected)
  })
})

describe('entries that vanish during the walk', () => {
  test('a file or directory removed after its directory was read is skipped', async () => {
    const root = scratch()
    put(root, 'a.ts')
    put(root, 'gone.ts')
    put(root, 'sub/x.ts')
    put(root, 'vanished/y.ts')
    expect(
      await walk(
        root,
        failing('NotFound', {
          lstat: ['gone.ts'],
          readDirectory: ['vanished'],
        }),
      ),
    ).toEqual(['a.ts', 'sub/x.ts'])
  })

  test('a missing root, or any other error, still fails the walk', async () => {
    const root = scratch()
    put(root, 'a.ts')
    put(root, 'sub/x.ts')
    expect(await walk(join(root, 'missing'))).toBeNull()
    expect(
      await walk(
        root,
        failing('NotFound', { readDirectory: [basename(root)] }),
      ),
    ).toBeNull()
    expect(
      await walk(root, failing('PermissionDenied', { lstat: ['a.ts'] })),
    ).toBeNull()
    expect(
      await walk(root, failing('PermissionDenied', { readDirectory: ['sub'] })),
    ).toBeNull()
  })
})

describe('concurrency', () => {
  test(`never has more than ${WALK_CONCURRENCY} file system calls in flight`, async () => {
    const root = scratch()
    const expected = tree(root, 3, 8).sort()
    let inFlight = 0
    let peak = 0
    const counted = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        return Effect.sleep('1 millis').pipe(
          Effect.andThen(effect),
          Effect.ensuring(
            Effect.sync(() => {
              inFlight -= 1
            }),
          ),
        )
      })
    const files = await walk(root, (fs) => ({
      ...fs,
      lstat: (path) => counted(fs.lstat(path)),
      readDirectory: (path, options) =>
        counted(fs.readDirectory(path, options)),
    }))
    expect(files).toEqual(expected)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(WALK_CONCURRENCY)
  })
})
