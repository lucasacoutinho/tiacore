import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'

import type { Baseline } from '../../../src/core/runtime.ts'
import { Baselines } from '../../../src/engine/ports.ts'
import { legacy } from '../../support/legacy.ts'
import { EngineLive } from '../support/layers.ts'
import {
  cleanupScratch,
  commit,
  init,
  put,
  repository,
  scratch,
  vcs,
} from '../support/repos.ts'

// HEAD and the repository top come from one git process, and an unchanged
// HEAD is not checked for ancestry. Every answer stays what 1.x gave, which
// asked for each separately.

const oracle = await legacy<{
  captureBaseline: (root: string, ignored: string | string[]) => Baseline | null
  changedFilesSince: (
    root: string,
    baseline: Baseline,
    ignored: string | string[],
  ) => string[] | null
  currentSha: (root: string) => string | null
}>('engine/baseline/capture.js')

const run = <A>(program: Effect.Effect<A, never, Baselines>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(EngineLive)))

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
  cleanupScratch()
})

/** Puts a `git` in front of the real one that records the arguments of every call. */
function recordCalls(): () => string[] {
  const directory = scratch('tia-record-')
  const log = join(directory, 'calls.txt')
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  writeFileSync(log, '')
  const binary = join(directory, 'git')
  writeFileSync(
    binary,
    `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`,
  )
  chmodSync(binary, 0o755)
  process.env.PATH = `${directory}:${originalPath}`
  return () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.replace('-c core.quotepath=false ', ''))
}

const HEAD_AND_TOP =
  'rev-parse --is-inside-work-tree --show-toplevel --verify HEAD'

const FILES = { 'src/a.ts': 'a\n', 'test/a.test.ts': 'test("a")\n' }

describe('git processes per operation', () => {
  test('a capture asks for HEAD and the top once, then lists the changes', async () => {
    const root = repository(FILES)
    put(root, 'src/a.ts', 'dirty\n')
    put(root, 'src/new.ts')
    const calls = recordCalls()
    const baseline = await run(
      Effect.flatMap(Baselines, (b) => b.capture(root, [])),
    )
    const asked = calls()
    expect(baseline).toEqual(oracle.captureBaseline(root, []))
    expect(asked).toHaveLength(3)
    expect(asked[0]).toBe(HEAD_AND_TOP)
    expect(asked.slice(1).sort()).toEqual([
      expect.stringMatching(/^diff --name-only /u),
      'ls-files -z --others --exclude-standard',
    ])
  })

  test('an unchanged HEAD is not checked for ancestry', async () => {
    const root = repository(FILES)
    const baseline = await run(
      Effect.flatMap(Baselines, (b) => b.capture(root, [])),
    )
    put(root, 'src/a.ts', 'edited\n')
    const calls = recordCalls()
    const changed = await run(
      Effect.flatMap(Baselines, (b) => b.changedSince(root, baseline!, [])),
    )
    const asked = calls()
    expect(changed).toEqual(['src/a.ts'])
    expect(changed).toEqual(oracle.changedFilesSince(root, baseline!, []))
    expect(asked.some((call) => call.startsWith('merge-base'))).toBe(false)
    expect(asked).toHaveLength(3)
  })

  test('a HEAD that moved is still checked for ancestry', async () => {
    const root = repository(FILES)
    const baseline = await run(
      Effect.flatMap(Baselines, (b) => b.capture(root, [])),
    )
    put(root, 'src/a.ts', 'advanced\n')
    commit(root, 'advance')
    const calls = recordCalls()
    const changed = await run(
      Effect.flatMap(Baselines, (b) => b.changedSince(root, baseline!, [])),
    )
    const asked = calls()
    expect(changed).toEqual(['src/a.ts'])
    expect(asked.filter((call) => call.startsWith('merge-base'))).toHaveLength(
      1,
    )
    expect(asked).toHaveLength(4)
  })

  test('the top found with HEAD serves every later listing in the same layer', async () => {
    const root = repository(FILES)
    const calls = recordCalls()
    await run(
      Effect.gen(function* () {
        const baselines = yield* Baselines
        const baseline = yield* baselines.capture(root, [])
        yield* baselines.changedSince(root, baseline!, [])
      }),
    )
    // capture: HEAD and top, diff, ls-files; changed-since: HEAD, diff, ls-files.
    expect(calls().filter((call) => call.includes('--show-toplevel'))).toEqual([
      HEAD_AND_TOP,
      HEAD_AND_TOP,
    ])
    expect(calls()).toHaveLength(6)
  })
})

describe('answers stay what 1.x gave', () => {
  test('a repository without commits has no HEAD and is captured from the file system', async () => {
    const root = scratch()
    init(root)
    put(root, 'src/a.ts')
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(root))),
    ).toBeNull()
    expect(oracle.currentSha(root)).toBeNull()
    const baseline = await run(
      Effect.flatMap(Baselines, (b) => b.capture(root, [])),
    )
    expect(baseline).toEqual(oracle.captureBaseline(root, []))
    expect(baseline?.source).toBe('filesystem')
  })

  test('the first commit after an unborn HEAD, in the same layer, lists from the learned top', async () => {
    const root = scratch()
    init(root)
    put(root, 'src/a.ts')
    const calls = recordCalls()
    const { first, second } = await run(
      Effect.gen(function* () {
        const baselines = yield* Baselines
        const unborn = yield* baselines.capture(root, [])
        yield* Effect.sync(() => commit(root, 'first'))
        put(root, 'src/b.ts')
        const born = yield* baselines.capture(root, [])
        return { first: unborn, second: born }
      }),
    )
    const asked = calls()
    expect(asked).not.toContain('rev-parse --show-toplevel')
    expect(asked.filter((call) => call === HEAD_AND_TOP)).toHaveLength(2)
    expect(first?.source).toBe('filesystem')
    expect(second).toEqual(oracle.captureBaseline(root, []))
    expect(second?.source).toBe('git')
    expect(Object.keys(second?.workingTree ?? {})).toEqual(['src/b.ts'])
  })

  test('outside a repository there is no HEAD, and one process asks', async () => {
    const root = scratch()
    put(root, 'src/a.ts')
    const calls = recordCalls()
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(root))),
    ).toBeNull()
    const asked = calls()
    expect(oracle.currentSha(root)).toBeNull()
    expect(asked).toEqual([HEAD_AND_TOP])
  })

  test('a git directory has a HEAD but no work tree, so no baseline', async () => {
    const root = repository(FILES)
    const gitDirectory = join(root, '.git')
    const sha = vcs(root, 'rev-parse', 'HEAD')
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(gitDirectory))),
    ).toBe(sha)
    expect(oracle.currentSha(gitDirectory)).toBe(sha)
    expect(oracle.captureBaseline(gitDirectory, [])).toBeNull()
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.capture(gitDirectory, []))),
    ).toBeNull()
  })

  test('a bare repository has a HEAD but no work tree, so no baseline', async () => {
    const source = repository(FILES)
    const bare = join(scratch(), 'bare.git')
    vcs(source, 'clone', '-q', '--bare', source, bare)
    const sha = vcs(source, 'rev-parse', 'HEAD')
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(bare))),
    ).toBe(sha)
    expect(oracle.currentSha(bare)).toBe(sha)
    expect(oracle.captureBaseline(bare, [])).toBeNull()
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.capture(bare, []))),
    ).toBeNull()
  })

  test('a directory name with spaces and a newline keeps its top', async () => {
    const root = join(scratch('tia odd\nname-'), 'my project')
    mkdirSync(root)
    init(root)
    put(root, 'src/a.ts')
    commit(root, 'baseline')
    put(root, 'src/a.ts', 'dirty\n')
    const baseline = await run(
      Effect.flatMap(Baselines, (b) => b.capture(join(root, 'src'), [])),
    )
    expect(baseline).toEqual(oracle.captureBaseline(join(root, 'src'), []))
    expect(Object.keys(baseline?.workingTree ?? {})).toEqual(['a.ts'])
  })
})
