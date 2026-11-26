import { strToU8, zipSync } from 'fflate'
import { describe, expect, test } from 'vitest'

import type {
  TiaArtifactCandidate,
  TiaArtifactProvider,
} from '../../src/core/artifacts.ts'
import type { TiaRuntimeGraph } from '../../src/core/runtime.ts'
import {
  archive as archiveOf,
  archiveGraph,
  cacheDirectory,
  graph,
  readStored,
  restore,
} from './support.ts'

// Restore policy and ancestry selection.

const unsigned = { allowUnsigned: true }

function provider(
  name: string,
  candidate: Awaited<ReturnType<TiaArtifactProvider['load']>>,
): TiaArtifactProvider {
  return { load: () => candidate, name }
}

describe('artifact restore policy', () => {
  test('rejects unsigned artifacts unless the policy allows them', async () => {
    const providers = [
      provider('unsigned storage', { graph: graph('current'), id: 'unsigned' }),
    ]
    const base = {
      cacheDir: cacheDirectory(),
      fingerprint: 'current',
      log: false,
      providers,
    }
    await expect(restore(base)).resolves.toEqual({
      reason: 'no provider returned a trusted compatible artifact',
      restored: false,
    })
    await expect(restore({ ...base, trust: {} })).resolves.toEqual({
      reason: 'no provider returned a trusted compatible artifact',
      restored: false,
    })
    await expect(restore({ ...base, trust: unsigned })).resolves.toMatchObject({
      restored: true,
    })
  })

  test('keeps a compatible local graph without calling a provider', async () => {
    const target = cacheDirectory()
    const first = await restore({
      cacheDir: target,
      fingerprint: 'current',
      log: false,
      providers: [provider('a', { graph: graph('current'), id: 1 })],
      trust: unsigned,
    })
    expect(first.restored).toBe(true)
    let calls = 0
    const second = await restore({
      cacheDir: target,
      fingerprint: 'current',
      log: false,
      providers: [
        {
          load: () => {
            calls += 1
            return null
          },
          name: 'never',
        },
      ],
      trust: unsigned,
    })
    expect(second).toEqual({
      reason: 'compatible local graph exists',
      restored: false,
    })
    expect(calls).toBe(0)
  })

  test('takes the first usable candidate in provider order', async () => {
    const result = await restore({
      cacheDir: cacheDirectory(),
      fingerprint: 'current',
      log: false,
      providers: [
        provider('ci', [
          { graph: graph('other'), id: 'other-fingerprint' },
          { graph: graph('current', { complete: false }), id: 'incomplete' },
          { graph: graph('current'), id: 'first' },
          { graph: graph('current'), id: 'second' },
        ]),
      ],
      trust: unsigned,
    })
    expect(result).toMatchObject({ artifactId: 'first', restored: true })
  })

  test('skips an artifact whose baseline commit is not an ancestor of HEAD', async () => {
    const target = cacheDirectory()
    const foreign = graph('current', {
      baseline: { sha: 'other-branch', source: 'git', workingTree: {} },
    })
    const result = await restore(
      {
        cacheDir: target,
        fingerprint: 'current',
        log: false,
        providers: [
          provider('first', { graph: foreign, id: 'foreign' }),
          provider('second', { graph: graph('current'), id: 'ancestral' }),
        ],
        trust: unsigned,
      },
      ['abc', 'head'],
    )
    expect(result).toMatchObject({ artifactId: 'ancestral', restored: true })
    expect((await readStored(target))?.baseline.sha).toBe('abc')
  })

  test('keeps a file-snapshot baseline without consulting history', async () => {
    const snapshot = graph('current', {
      baseline: { sha: '', source: 'filesystem', workingTree: { 'a.ts': 'h' } },
    })
    const result = await restore(
      {
        cacheDir: cacheDirectory(),
        fingerprint: 'current',
        log: false,
        providers: [provider('ci', { graph: snapshot, id: 'fs' })],
        trust: unsigned,
      },
      [],
    )
    expect(result.restored).toBe(true)
  })

  test('does not commit a commit-based baseline when HEAD is unavailable', async () => {
    const target = cacheDirectory()
    const result = await restore(
      {
        cacheDir: target,
        fingerprint: 'current',
        log: false,
        providers: [provider('ci', { graph: graph('current'), id: 'x' })],
        trust: unsigned,
      },
      [],
    )
    expect(result.restored).toBe(false)
    expect(await readStored(target)).toBeNull()
  })

  test('refuses an unsafe runner namespace', async () => {
    await expect(
      restore({
        cacheDir: cacheDirectory(),
        fingerprint: 'current',
        log: false,
        providers: [],
        runner: '../escape',
      }),
    ).rejects.toThrow('TIA artifact runner must be a safe relative path')
  })
})

// A provider that names no group, as a custom one or a manifest entry may.

function part(
  group: string,
  index: number,
  overrides: Partial<TiaRuntimeGraph> = {},
): TiaRuntimeGraph {
  return graph('parts', {
    complete: false,
    partition: { group, index, total: 2 },
    ...overrides,
  })
}

function restoreParts(
  candidates: TiaArtifactCandidate[],
  options: { commits?: string[]; coverageRequested?: boolean } = {},
) {
  return restore(
    {
      cacheDir: cacheDirectory(),
      ...(options.coverageRequested === undefined
        ? {}
        : { coverageRequested: options.coverageRequested }),
      fingerprint: 'parts',
      log: false,
      providers: [provider('shards', candidates)],
      trust: unsigned,
    },
    options.commits,
  )
}

describe('partition restore', () => {
  test('a fragment of another partition group listed first does not block a complete set', async () => {
    const result = await restoreParts([
      { graph: part('run-b', 2), id: 'b2' },
      { graph: part('run-a', 1), id: 'a1' },
      { graph: part('run-a', 2), id: 'a2' },
    ])
    expect(result).toMatchObject({ artifactId: ['a1', 'a2'], restored: true })
  })

  test('a stale fragment listed first does not block a complete set', async () => {
    const staleBaseline = part('run-a', 1, {
      baseline: { sha: 'old', workingTree: {} },
    })
    const staleTotal = part('run-a', 1, {
      partition: { group: 'run-a', index: 1, total: 3 },
    })
    for (const stale of [staleBaseline, staleTotal]) {
      const result = await restoreParts(
        [
          { graph: stale, id: 'stale' },
          { graph: part('run-a', 1), id: 'a1' },
          { graph: part('run-a', 2), id: 'a2' },
        ],
        { commits: ['old', 'abc'] },
      )
      expect(result).toMatchObject({
        artifactId: ['a1', 'a2'],
        restored: true,
      })
    }
  })

  test('reports only the fragments the merge used', async () => {
    const result = await restoreParts([
      { graph: part('run-a', 1), id: 'a1' },
      { graph: part('run-a', 2), id: 'a2' },
      { graph: part('run-b', 2), id: 'b2' },
    ])
    expect(result).toMatchObject({ artifactId: ['a1', 'a2'], restored: true })
  })

  test('a merged set without the requested coverage does not block a later one', async () => {
    const partial = { coverageComplete: false }
    const result = await restoreParts(
      [
        { graph: part('run-c', 1, partial), id: 'c1' },
        { graph: part('run-c', 2, partial), id: 'c2' },
        { graph: part('run-a', 1), id: 'a1' },
        { graph: part('run-a', 2), id: 'a2' },
      ],
      { coverageRequested: true },
    )
    expect(result).toMatchObject({ artifactId: ['a1', 'a2'], restored: true })
  })

  test('a provider group of any value, even one JSON cannot encode, still merges', async () => {
    const group = 1n as unknown as number
    const result = await restoreParts([
      { graph: part('run-a', 1), group, id: 'a1' },
      { graph: part('run-a', 2), group, id: 'a2' },
    ])
    expect(result).toMatchObject({ artifactId: ['a1', 'a2'], restored: true })
  })

  test('fragments a provider puts in different groups never merge', async () => {
    for (const [first, second] of [
      [10, 20],
      [1, '1'],
    ] as const) {
      const result = await restoreParts([
        { graph: part('run-a', 1), group: first, id: 'a1' },
        { graph: part('run-a', 2), group: second, id: 'a2' },
      ])
      expect(result.restored).toBe(false)
    }
  })
})

describe('archive entry names', () => {
  test('an archive naming a path outside its directory is rejected whole', () => {
    const entry = strToU8(JSON.stringify(graph('current')))
    expect(
      archiveGraph(
        zipSync({ '../outside.txt': strToU8('x'), 'graph.json': entry }),
        undefined,
      ),
    ).toBeNull()
    expect(
      archiveGraph(
        zipSync({ '/etc/passwd': strToU8('x'), 'graph.json': entry }),
        undefined,
      ),
    ).toBeNull()
    expect(
      archiveGraph(
        zipSync({ 'a\\b.txt': strToU8('x'), 'graph.json': entry }),
        undefined,
      ),
    ).toBeNull()
    expect(archiveGraph(archiveOf('current'), undefined)).not.toBeNull()
  })

  test('a runner namespace that climbs out of the archive finds nothing', () => {
    expect(archiveGraph(archiveOf('current'), '../escape')).toBeNull()
  })
})
