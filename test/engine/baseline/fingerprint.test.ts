import { fstatSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import { afterEach, describe, expect, test } from 'vitest'

import { VERSION } from '../../../src/core/version.ts'
import {
  DELETED_HASH,
  fingerprintRuntime,
  hashBytes,
  hashFile,
  projectFingerprint,
  STRUCTURAL_FILE_PATTERN,
  UNAVAILABLE_HASH,
} from '../../../src/engine/baseline/fingerprint.ts'
import type { FingerprintOptions } from '../../../src/engine/baseline/options.ts'
import { legacy } from '../../support/legacy.ts'
import { cleanupScratch, put, scratch } from '../support/repos.ts'

const oracle = await legacy<{
  hashBytes: typeof hashBytes
  hashFile: (path: string) => string
}>('engine/baseline/fingerprint.js')
const constants = await legacy<{ STRUCTURAL_FILE_PATTERN: RegExp }>(
  'shared/constants.js',
)

const options: FingerprintOptions = {
  exclude: ['**/dist/**'],
  frameworkFingerprint: 'vitest-5',
  ignoreChanges: ['docs/**'],
  include: ['**/*.ts'],
  onUnknownChange: 'full',
}

const withFs = <A, E>(
  program: (
    fs: FileSystem.FileSystem,
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, program).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )

const fingerprint = (root: string, extra: string[] = [], opts = options) =>
  Effect.runPromise(
    projectFingerprint(root, opts, extra).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )

/** Runs `body` with `process.versions.bun` set, then restores it. */
const withBun = async <T>(
  version: string | undefined,
  body: () => Promise<T>,
): Promise<T> => {
  const versions = process.versions as NodeJS.ProcessVersions & {
    bun?: string
  }
  const had = Object.hasOwn(versions, 'bun')
  const previous = versions.bun
  try {
    if (version === undefined) Reflect.deleteProperty(versions, 'bun')
    else {
      Object.defineProperty(versions, 'bun', {
        configurable: true,
        enumerable: true,
        value: version,
        writable: true,
      })
    }
    return await body()
  } finally {
    if (!had) Reflect.deleteProperty(versions, 'bun')
    else {
      Object.defineProperty(versions, 'bun', {
        configurable: true,
        enumerable: true,
        value: previous,
        writable: true,
      })
    }
  }
}

afterEach(cleanupScratch)

describe('hashing', () => {
  test('hashBytes is sha256 hex of strings and bytes', () => {
    expect(hashBytes('abc')).toBe(oracle.hashBytes('abc'))
    expect(hashBytes(Buffer.from('abc'))).toBe(oracle.hashBytes('abc'))
    expect(hashBytes(new Uint8Array([97, 98, 99]))).toBe(
      oracle.hashBytes('abc'),
    )
  })

  test('hashFile agrees with 1.x and uses the sentinels', async () => {
    const root = scratch()
    put(root, 'a.ts', 'content')
    symlinkSync(join(root, 'missing'), join(root, 'broken'))
    symlinkSync(join(root, 'a.ts'), join(root, 'link'))
    const hash = (name: string) =>
      withFs((fs) => hashFile(fs, join(root, name)))
    expect(await hash('a.ts')).toBe(oracle.hashFile(join(root, 'a.ts')))
    expect(await hash('link')).toBe(await hash('a.ts'))
    expect(await hash('nope.ts')).toBe(DELETED_HASH)
    expect(await hash('broken')).toBe(DELETED_HASH)
    expect(await hash('nope/under/missing.ts')).toBe(DELETED_HASH)
    expect(await hash('.')).toBe(UNAVAILABLE_HASH)
    expect(DELETED_HASH).toBe('<deleted>')
    expect(UNAVAILABLE_HASH).toBe('<unavailable>')
  })

  test('hashFile refuses files of 2 GiB and more without reading them', async () => {
    const root = scratch()
    const big = join(root, 'big')
    writeFileSync(big, '')
    truncateSync(big, 2 ** 31)
    expect(await withFs((fs) => hashFile(fs, big))).toBe(UNAVAILABLE_HASH)
  })

  test('hashes files on both sides of the streaming threshold', async () => {
    const root = scratch()
    const counts = { read: 0, stream: 0 }
    await withFs((fs) =>
      Effect.gen(function* () {
        const measured = FileSystem.FileSystem.of({
          ...fs,
          readFile: (path) => {
            counts.read += 1
            return fs.readFile(path)
          },
          stream: (path, streamOptions) => {
            counts.stream += 1
            return fs.stream(path, streamOptions)
          },
        })
        for (const size of [
          8 * 1024 * 1024 - 1,
          8 * 1024 * 1024,
          9 * 1024 * 1024 + 13,
        ]) {
          const content = Buffer.alloc(size, size % 251)
          const path = join(root, String(size))
          writeFileSync(path, content)
          expect(yield* hashFile(measured, path)).toBe(hashBytes(content))
          if (size === 8 * 1024 * 1024) {
            const effect = hashFile(measured, path)
            expect(
              yield* Effect.all([effect, effect], { concurrency: 2 }),
            ).toEqual([hashBytes(content), hashBytes(content)])
          }
        }
      }),
    )
    expect(counts).toEqual({ read: 1, stream: 4 })
  })

  test('maps stream read failures to sentinels and closes the file', async () => {
    const root = scratch()
    const path = join(root, 'large')
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024))
    for (const [tag, expected] of [
      ['NotFound', DELETED_HASH],
      ['PermissionDenied', UNAVAILABLE_HASH],
    ] as const) {
      await withFs((fs) =>
        Effect.gen(function* () {
          let descriptor = -1
          let reads = 0
          const controlled = FileSystem.make({
            ...fs,
            open: (filePath, openOptions) =>
              fs.open(filePath, openOptions).pipe(
                Effect.map((file) => {
                  descriptor = Reflect.get(file, 'fd') as number
                  return new Proxy(file, {
                    get(target, property, receiver) {
                      if (property === 'readAlloc') {
                        return (size: number) =>
                          Effect.suspend(() => {
                            reads += 1
                            return reads === 1
                              ? file.readAlloc(size)
                              : Effect.fail(
                                  PlatformError.systemError({
                                    _tag: tag,
                                    method: 'read',
                                    module: 'FileSystem',
                                  }),
                                )
                          })
                      }
                      const value: unknown = Reflect.get(
                        target,
                        property,
                        receiver,
                      )
                      return typeof value === 'function'
                        ? value.bind(target)
                        : value
                    },
                  })
                }),
              ),
          })
          expect(yield* hashFile(controlled, path)).toBe(expected)
          expect(reads).toBe(2)
          expect(() => fstatSync(descriptor)).toThrow('EBADF')
        }),
      )
    }
  })

  test('closes the streamed file when hashing is interrupted', async () => {
    const root = scratch()
    const path = join(root, 'large')
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024))
    await withFs((fs) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        let descriptor = -1
        const controlled = FileSystem.make({
          ...fs,
          open: (filePath, openOptions) =>
            fs.open(filePath, openOptions).pipe(
              Effect.map((file) => {
                descriptor = Reflect.get(file, 'fd') as number
                return new Proxy(file, {
                  get(target, property, receiver) {
                    if (property === 'readAlloc') {
                      return () =>
                        Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Effect.never),
                        )
                    }
                    const value: unknown = Reflect.get(
                      target,
                      property,
                      receiver,
                    )
                    return typeof value === 'function'
                      ? value.bind(target)
                      : value
                  },
                })
              }),
            ),
        })
        const fiber = yield* Effect.forkChild(hashFile(controlled, path))
        yield* Deferred.await(entered)
        expect(fstatSync(descriptor).isFile()).toBe(true)
        yield* Fiber.interrupt(fiber)
        expect(() => fstatSync(descriptor)).toThrow('EBADF')
      }),
    )
  })
})

describe('project fingerprint', () => {
  test('keeps the structural file pattern of 1.x', () => {
    expect(STRUCTURAL_FILE_PATTERN.source).toBe(
      constants.STRUCTURAL_FILE_PATTERN.source,
    )
    for (const name of [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
      'tsconfig.json',
      'tsconfig.build.json',
      'jsconfig.json',
      'vite.config.ts',
      'vitest.config.mts',
      'vitest.config.js',
      'vitest.unit.config.ts',
    ]) {
      expect(STRUCTURAL_FILE_PATTERN.test(name), name).toBe(
        constants.STRUCTURAL_FILE_PATTERN.test(name),
      )
    }
    expect(STRUCTURAL_FILE_PATTERN.test('package.json')).toBe(true)
    expect(STRUCTURAL_FILE_PATTERN.test('sub/package.json')).toBe(false)
    expect(STRUCTURAL_FILE_PATTERN.test('vitest.workspace.ts')).toBe(false)
    expect(STRUCTURAL_FILE_PATTERN.test('xpackage.json')).toBe(false)
  })

  test('binds to structure, options, platform, Node major, runtime and version', async () => {
    const root = scratch()
    put(root, 'package.json', '{}\n')
    put(root, 'src/a.ts')
    const base = await fingerprint(root)
    expect(base).toMatch(/^[a-f0-9]{64}$/u)
    expect(await fingerprint(root)).toBe(base)

    const expected = hashBytes(
      JSON.stringify({
        arch: process.arch,
        exclude: options.exclude,
        frameworks: options.frameworkFingerprint,
        ignoreChanges: options.ignoreChanges,
        include: options.include,
        node: process.versions.node.split('.')[0],
        onUnknownChange: options.onUnknownChange,
        platform: process.platform,
        plugin: VERSION,
        runtime: fingerprintRuntime(),
        structural: [['package.json', hashBytes('{}\n')]],
      }),
    )
    expect(base).toBe(expected)

    for (const changed of [
      { ...options, exclude: [] },
      { ...options, include: ['**/*.js'] },
      { ...options, ignoreChanges: [] },
      { ...options, frameworkFingerprint: 'vitest-6' },
      { ...options, onUnknownChange: 'ignore' as const },
    ]) {
      expect(await fingerprint(root, [], changed)).not.toBe(base)
    }
  })

  test('names Bun by its major and Node.js otherwise', () => {
    expect(fingerprintRuntime({})).toBe('node')
    expect(fingerprintRuntime({ bun: undefined })).toBe('node')
    expect(fingerprintRuntime({ bun: '' })).toBe('node')
    expect(fingerprintRuntime({ bun: '.' })).toBe('node')
    expect(fingerprintRuntime({ bun: '1.4.4' })).toBe('bun-1')
    expect(fingerprintRuntime({ bun: '1.9.0' })).toBe('bun-1')
    expect(fingerprintRuntime({ bun: '2.0.0' })).toBe('bun-2')
    expect(fingerprintRuntime({ bun: '1.4.4', node: '26.3.0' })).toBe('bun-1')
  })

  test('a Bun fingerprint differs from Node when the Node major matches', async () => {
    const root = scratch()
    put(root, 'package.json', '{}\n')
    const nodeMajor = process.versions.node.split('.')[0]
    const payload = (runtime: string) =>
      hashBytes(
        JSON.stringify({
          arch: process.arch,
          exclude: options.exclude,
          frameworks: options.frameworkFingerprint,
          ignoreChanges: options.ignoreChanges,
          include: options.include,
          node: nodeMajor,
          onUnknownChange: options.onUnknownChange,
          platform: process.platform,
          plugin: VERSION,
          runtime,
          structural: [['package.json', hashBytes('{}\n')]],
        }),
      )

    const onNode = await withBun(undefined, () => fingerprint(root))
    const onBun = await withBun('1.4.4', () => fingerprint(root))
    expect(onNode).toBe(payload('node'))
    expect(onBun).toBe(payload('bun-1'))
    expect(onBun).not.toBe(onNode)
    expect(await withBun('1.9.0', () => fingerprint(root))).toBe(onBun)
    expect(await withBun('2.0.0', () => fingerprint(root))).toBe(
      payload('bun-2'),
    )
    expect(await withBun('', () => fingerprint(root))).toBe(onNode)
  })

  test('hashes structural files of the root only, and not through symlinks', async () => {
    const root = scratch()
    put(root, 'package.json', '{}\n')
    const base = await fingerprint(root)
    put(root, 'sub/package.json', 'nested\n')
    put(root, 'src/a.ts', 'source\n')
    expect(await fingerprint(root)).toBe(base)
    put(root, 'package.json', '{"changed":1}\n')
    const changed = await fingerprint(root)
    expect(changed).not.toBe(base)
    put(root, 'real-lock', 'x')
    symlinkSync(join(root, 'real-lock'), join(root, 'yarn.lock'))
    expect(await fingerprint(root)).toBe(changed)
    put(root, 'vitest.config.ts', 'export default {}\n')
    expect(await fingerprint(root)).not.toBe(changed)
  })

  test('adds extra files, sorted, with a deleted marker for missing ones', async () => {
    const root = scratch()
    put(root, 'package.json', '{}\n')
    const base = await fingerprint(root)
    const withMissing = await fingerprint(root, ['custom.config', ''])
    expect(withMissing).not.toBe(base)
    expect(await fingerprint(root, ['', 'custom.config'])).toBe(withMissing)
    put(root, 'custom.config', 'now present')
    expect(await fingerprint(root, ['custom.config'])).not.toBe(withMissing)
    expect(await fingerprint(root, ['custom.config', 'package.json'])).toBe(
      await fingerprint(root, ['package.json', 'custom.config']),
    )
  })

  test('fails with an I/O error when the root cannot be read', async () => {
    const exit = await Effect.runPromise(
      Effect.flip(projectFingerprint('/definitely/not/here', options)).pipe(
        Effect.provide(NodeServices.layer),
      ),
    )
    expect(exit._tag).toBe('TiaIo')
  })
})
