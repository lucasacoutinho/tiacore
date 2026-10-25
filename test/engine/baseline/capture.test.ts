import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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

// The live Baselines against the built 1.x capture module on the same scratch
// projects.

const oracle = await legacy<{
  captureBaseline: (root: string, ignored: string | string[]) => Baseline | null
  changedFilesSince: (
    root: string,
    baseline: Baseline,
    ignored: string | string[],
  ) => string[] | null
  currentSha: (root: string) => string | null
  isAncestor: (root: string, a: string, d: string) => boolean
}>('engine/baseline/capture.js')

const run = <A>(program: Effect.Effect<A, never, Baselines>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(EngineLive)))

const capture = (root: string, ignored: string[] = []) =>
  run(Effect.flatMap(Baselines, (b) => b.capture(root, ignored)))
const changedSince = (
  root: string,
  baseline: Baseline,
  ignored: string[] = [],
) =>
  run(Effect.flatMap(Baselines, (b) => b.changedSince(root, baseline, ignored)))
const currentSha = (root: string) =>
  run(Effect.flatMap(Baselines, (b) => b.currentSha(root)))
const isAncestor = (root: string, a: string, d: string) =>
  run(Effect.flatMap(Baselines, (b) => b.isAncestor(root, a, d)))

afterEach(cleanupScratch)

const FILES = {
  '.gitignore': 'ignored.log\nbuild/\n',
  'package.json': '{}\n',
  'src/a.ts': 'export const a = 1\n',
  'src/b.ts': 'export const b = 1\n',
  'test/a.test.ts': 'test("a")\n',
}

interface Scenario {
  quiet?: boolean
  mutate?: (root: string) => void
  name: string
  prepare?: (root: string) => void
  ignored?: string[]
}

const scenarios: Scenario[] = [
  { name: 'a clean checkout' },
  {
    name: 'a modified tracked file',
    prepare: (root) => put(root, 'src/a.ts', 'export const a = 2\n'),
    mutate: (root) => put(root, 'src/a.ts', 'export const a = 3\n'),
  },
  {
    name: 'staged and unstaged edits',
    prepare: (root) => {
      put(root, 'src/a.ts', 'staged\n')
      vcs(root, 'add', 'src/a.ts')
      put(root, 'src/a.ts', 'staged then edited\n')
    },
    mutate: (root) => put(root, 'src/b.ts', 'later\n'),
  },
  {
    name: 'a deleted tracked file, restored afterwards',
    prepare: (root) => unlinkSync(join(root, 'src/b.ts')),
    mutate: (root) => put(root, 'src/b.ts', 'export const b = 1\n'),
  },
  {
    name: 'untracked files, some ignored by .gitignore',
    prepare: (root) => {
      put(root, 'src/new.ts')
      put(root, 'ignored.log')
      put(root, 'build/out.js')
    },
    mutate: (root) => put(root, 'src/new.ts', 'changed\n'),
  },
  {
    name: 'ignored prefixes for a cache directory',
    ignored: ['.tia', 'coverage/report', ''],
    prepare: (root) => {
      put(root, '.tia/state.json')
      put(root, 'coverage/report/index.html')
      put(root, 'coverage/other.txt')
    },
    mutate: (root) => {
      put(root, '.tia/state.json', 'changed\n')
      put(root, 'coverage/other.txt', 'changed\n')
    },
  },
  {
    name: 'file names with spaces, unicode and newlines',
    prepare: (root) => {
      put(root, 'src/with space.ts')
      put(root, 'src/ünïcode.ts')
      put(root, 'src/new\nline.ts')
    },
    mutate: (root) => put(root, 'src/ünïcode.ts', 'changed\n'),
  },
  {
    name: 'temporary tool files created by Vite and Bun',
    quiet: true,
    prepare: (root) => {
      put(root, 'vitest.config.ts.timestamp-1700000000-abc123.mjs')
      put(root, '.abc-123.bun-build')
    },
    mutate: (root) => put(root, '.abc-123.bun-build', 'changed\n'),
  },
  {
    name: 'a new commit after the baseline',
    quiet: true,
    prepare: (root) => put(root, 'src/a.ts', 'dirty\n'),
    mutate: (root) => {
      vcs(root, 'add', '-A')
      vcs(root, 'commit', '-q', '-m', 'advance')
    },
  },
]

describe('git baselines match 1.x', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name}`, async () => {
      const root = repository(FILES)
      scenario.prepare?.(root)
      const ignored = scenario.ignored ?? []
      const expected = oracle.captureBaseline(root, ignored)
      expect(await capture(root, ignored)).toEqual(expected)
      expect(expected?.source).toBe('git')
      if (expected === null) return

      expect(await changedSince(root, expected, ignored)).toEqual(
        oracle.changedFilesSince(root, expected, ignored),
      )
      expect(await changedSince(root, expected, ignored)).toEqual([])
      scenario.mutate?.(root)
      const after = await changedSince(root, expected, ignored)
      expect(after).toEqual(oracle.changedFilesSince(root, expected, ignored))
      expect(await capture(root, ignored)).toEqual(
        oracle.captureBaseline(root, ignored),
      )
      if (scenario.mutate !== undefined && scenario.quiet !== true) {
        expect(after).not.toEqual([])
      }
    })
  }

  test('records the exact working tree of a dirty checkout', async () => {
    const root = repository(FILES)
    put(root, 'src/a.ts', 'dirty\n')
    unlinkSync(join(root, 'src/b.ts'))
    put(root, 'src/new.ts', 'fresh\n')
    const baseline = await capture(root)
    expect(Object.keys(baseline?.workingTree ?? {})).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/new.ts',
    ])
    expect(baseline?.workingTree['src/b.ts']).toBe('<deleted>')
    expect(baseline?.workingTree['src/a.ts']).toMatch(/^[a-f0-9]{64}$/u)
    expect(baseline?.sha).toBe(vcs(root, 'rev-parse', 'HEAD'))
    expect((await capture(repository(FILES)))?.workingTree).toEqual({})
  })

  test('relativizes repository listings to a nested project root', async () => {
    const outer = repository({
      'app/src/a.ts': 'a\n',
      'other/x.ts': 'x\n',
      'package.json': '{}\n',
    })
    put(outer, 'app/src/a.ts', 'dirty\n')
    put(outer, 'other/x.ts', 'dirty\n')
    const root = join(outer, 'app')
    const baseline = await capture(root)
    expect(baseline).toEqual(oracle.captureBaseline(root, []))
    expect(Object.keys(baseline?.workingTree ?? {})).toEqual([
      '../other/x.ts',
      'src/a.ts',
    ])
  })

  test('skips untracked files that vanish and reports deletions', async () => {
    const root = repository(FILES)
    put(root, 'src/new.ts')
    const baseline = await capture(root)
    unlinkSync(join(root, 'src/new.ts'))
    expect(await changedSince(root, baseline!)).toEqual(['src/new.ts'])
  })
})

const tree = (root: string) => {
  put(
    root,
    '.gitignore',
    '# comment\n*.log\n/dist-like/\n!keep.log\nnested/*.tmp\n\nsrc/generated/\n',
  )
  put(root, 'src/a.ts')
  put(root, 'src/generated/g.ts')
  put(root, 'src/coverage/keep.ts')
  put(root, 'coverage/skip.ts')
  put(root, 'dist/skip.js')
  put(root, 'build/skip.js')
  put(root, 'src/dist/keep.js')
  put(root, 'node_modules/pkg/index.js')
  put(root, 'deep/node_modules/pkg/index.js')
  put(root, '.git-like/file')
  put(root, 'debug.log')
  put(root, 'keep.log')
  put(root, 'nested/a.tmp')
  put(root, 'nested/b.txt')
  put(root, 'dist-like/x.txt')
  put(root, '.cache/c')
  put(root, '.turbo/t')
  put(root, '.tia/state.json')
  put(root, 'vitest.config.ts.timestamp-1700000000-abc123.mjs')
  put(root, 'real.ts')
  symlinkSync(join(root, 'real.ts'), join(root, 'link-to-file.ts'))
  mkdirSync(join(root, 'empty-dir'))
}

describe('filesystem baselines match 1.x', () => {
  test('walks a project outside a repository with the .gitignore rules', async () => {
    const root = scratch()
    tree(root)
    const expected = oracle.captureBaseline(root, ['custom-cache'])
    const actual = await capture(root, ['custom-cache'])
    expect(actual).toEqual(expected)
    expect(actual).toMatchObject({ sha: '', source: 'filesystem' })
    const files = Object.keys(actual?.workingTree ?? {})
    expect(files).toContain('src/coverage/keep.ts')
    expect(files).toContain('src/dist/keep.js')
    expect(files).toContain('keep.log')
    expect(files).not.toContain('coverage/skip.ts')
    expect(files).not.toContain('debug.log')
    expect(files).not.toContain('link-to-file.ts')
    expect(files).not.toContain('deep/node_modules/pkg/index.js')
    expect(files.some((file) => file.startsWith('empty-dir'))).toBe(false)
    expect(files.some((file) => file.includes('timestamp-'))).toBe(false)
  })

  test('detects edits, additions and deletions', async () => {
    const root = scratch()
    tree(root)
    const baseline = (await capture(root))!
    expect(await changedSince(root, baseline)).toEqual([])
    put(root, 'src/a.ts', 'edited\n')
    put(root, 'added.ts')
    unlinkSync(join(root, 'real.ts'))
    const changed = await changedSince(root, baseline)
    expect(changed).toEqual(oracle.changedFilesSince(root, baseline, []))
    expect(changed).toEqual(['added.ts', 'real.ts', 'src/a.ts'])
  })

  test('also covers a repository without commits and a project git cannot read', async () => {
    const root = scratch()
    init(root)
    put(root, 'src/a.ts')
    const unborn = await capture(root)
    expect(unborn).toEqual(oracle.captureBaseline(root, []))
    expect(unborn?.source).toBe('filesystem')
    expect(await currentSha(root)).toBeNull()
  })
})

describe('fail-safe capture', () => {
  test('an untracked symlink to a directory makes the baseline null', async () => {
    const root = repository(FILES)
    mkdirSync(join(root, 'real-dir'))
    symlinkSync(join(root, 'real-dir'), join(root, 'linked-dir'))
    expect(oracle.captureBaseline(root, [])).toBeNull()
    expect(await capture(root)).toBeNull()
  })

  test('an untracked nested repository makes the baseline null', async () => {
    const root = repository(FILES)
    const nested = join(root, 'vendor/lib')
    mkdirSync(nested, { recursive: true })
    init(nested)
    put(nested, 'x.ts')
    commit(nested)
    expect(oracle.captureBaseline(root, [])).toBeNull()
    expect(await capture(root)).toBeNull()
  })

  test('a submodule whose commit changed makes the baseline null', async () => {
    const lib = repository({ 'lib.ts': 'lib\n' })
    const root = repository(FILES)
    vcs(
      root,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      lib,
      'vendor/lib',
    )
    commit(root, 'add submodule')
    expect((await capture(root))?.workingTree).toEqual({})
    vcs(join(root, 'vendor/lib'), 'config', 'user.email', 'tia@example.test')
    vcs(join(root, 'vendor/lib'), 'config', 'user.name', 'TIA')
    put(join(root, 'vendor/lib'), 'lib.ts', 'moved\n')
    commit(join(root, 'vendor/lib'), 'advance submodule')
    expect(oracle.captureBaseline(root, [])).toBeNull()
    expect(await capture(root)).toBeNull()
  })

  test.skipIf(process.getuid?.() === 0)(
    'an unreadable file makes the baseline null',
    async () => {
      const root = repository(FILES)
      put(root, 'secret.txt')
      chmodSync(join(root, 'secret.txt'), 0)
      expect(oracle.captureBaseline(root, [])).toBeNull()
      expect(await capture(root)).toBeNull()
      chmodSync(join(root, 'secret.txt'), 0o644)
    },
  )

  test('a file of 2 GiB or more makes the baseline null', async () => {
    const root = repository(FILES)
    const big = join(root, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, 2 ** 31)
    expect(await capture(root)).toBeNull()
    truncateSync(big, 2 ** 31 - 1)
    // Below the limit it is hashed (sparse, so cheap on disk).
    expect((await capture(root))?.workingTree['big.bin']).toMatch(
      /^[a-f0-9]{64}$/u,
    )
    rmSync(big)
  })

  test('changed-since is null when a candidate cannot be hashed', async () => {
    const root = repository(FILES)
    const baseline = (await capture(root))!
    mkdirSync(join(root, 'real-dir'))
    symlinkSync(join(root, 'real-dir'), join(root, 'linked-dir'))
    expect(oracle.changedFilesSince(root, baseline, [])).toBeNull()
    expect(await changedSince(root, baseline)).toBeNull()
  })

  test('a filesystem baseline is null for an unhashable file', async () => {
    const root = scratch()
    put(root, 'a.ts')
    const baseline = (await capture(root))!
    const big = join(root, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, 2 ** 31)
    expect(await changedSince(root, baseline)).toBeNull()
  })
})

describe('commits and ancestry', () => {
  test('reads HEAD, and nothing outside a repository or on an unborn HEAD', async () => {
    const root = repository(FILES)
    expect(await currentSha(root)).toBe(vcs(root, 'rev-parse', 'HEAD'))
    expect(await currentSha(root)).toBe(oracle.currentSha(root))
    expect(await currentSha(scratch())).toBeNull()
    const unborn = scratch()
    init(unborn)
    expect(await currentSha(unborn)).toBeNull()
    expect(await currentSha(join(root, 'does-not-exist'))).toBeNull()
  })

  test('is true only for an ancestor or the same commit', async () => {
    const root = repository(FILES)
    const first = vcs(root, 'rev-parse', 'HEAD')
    put(root, 'src/a.ts', 'next\n')
    const second = commit(root, 'next')
    vcs(root, 'checkout', '-q', '-b', 'side', first)
    put(root, 'side.ts')
    const side = commit(root, 'side')
    for (const [a, d] of [
      [first, second],
      [second, first],
      [first, first],
      [second, side],
      ['0'.repeat(40), second],
      ['', second],
      [first, 'nonsense'],
    ] as const) {
      expect(await isAncestor(root, a, d), `${a} ${d}`).toBe(
        oracle.isAncestor(root, a, d),
      )
    }
    expect(await isAncestor(root, first, second)).toBe(true)
    expect(await isAncestor(root, second, side)).toBe(false)
  })

  test('reuses a graph from an ancestor and rejects a baseline that is not one', async () => {
    const root = repository(FILES)
    const baseline = (await capture(root))!
    put(root, 'src/a.ts', 'advanced\n')
    commit(root, 'advance')
    expect(await changedSince(root, baseline)).toEqual(['src/a.ts'])
    const detached = { ...baseline, sha: '1'.repeat(40) }
    expect(await changedSince(root, detached)).toBeNull()
    expect(oracle.changedFilesSince(root, detached, [])).toBeNull()
    vcs(root, 'checkout', '-q', '-b', 'old', baseline.sha)
    vcs(root, 'reset', '-q', '--hard', baseline.sha)
    const ahead = { ...baseline, sha: vcs(root, 'rev-parse', 'main') }
    expect(await changedSince(root, ahead)).toBeNull()
  })

  test('is null for a git baseline outside a repository', async () => {
    const root = scratch()
    expect(
      await changedSince(root, { sha: 'abc', source: 'git', workingTree: {} }),
    ).toBeNull()
    expect(await changedSince(root, { sha: 'abc', workingTree: {} })).toBeNull()
  })

  test('treats a baseline without a source as git', async () => {
    const root = repository(FILES)
    const baseline = (await capture(root))!
    const { source: _source, ...bare } = baseline
    put(root, 'src/a.ts', 'dirty\n')
    expect(await changedSince(root, bare)).toEqual(['src/a.ts'])
  })

  test('counts a rename as a delete and an add', async () => {
    const root = repository(FILES)
    const baseline = (await capture(root))!
    vcs(root, 'mv', 'src/a.ts', 'src/renamed.ts')
    expect(await changedSince(root, baseline)).toEqual([
      'src/a.ts',
      'src/renamed.ts',
    ])
  })
})
