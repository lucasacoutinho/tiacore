import { symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { afterEach, describe, expect, test } from 'vitest'

import { VERSION } from '../../../src/core/version.ts'
import {
  DELETED_HASH,
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

  test('binds to structure, options, platform, Node major and version', async () => {
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
