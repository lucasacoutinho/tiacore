import * as Effect from 'effect/Effect'
import { describe, expect, test } from 'vitest'

import { Baselines } from '../../../src/engine/ports.ts'
import {
  BaselinesMemory,
  baselinesMemory,
  type MemoryProject,
} from '../../../src/engine/baseline/memory.ts'

const run = <A>(
  projects: Map<string, MemoryProject>,
  use: (baselines: Baselines['Service']) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.flatMap(Baselines, use).pipe(
      Effect.provide(baselinesMemory(projects)),
    ),
  )

const project = (): MemoryProject => ({
  commits: [
    { files: { 'a.ts': 'h1', 'b.ts': 'h2' }, sha: 'c1' },
    { files: { 'a.ts': 'h1', 'b.ts': 'h3' }, sha: 'c2' },
  ],
  files: { 'a.ts': 'h1', 'b.ts': 'h3' },
})

describe('in-memory baselines follow the live algorithm', () => {
  test('capture records what differs from HEAD, deletions and untracked files', async () => {
    const p = project()
    p.files = { 'a.ts': 'dirty', 'new.ts': 'n1' }
    p.untracked = ['new.ts']
    const projects = new Map([['/p', p]])
    expect(await run(projects, (b) => b.capture('/p', []))).toEqual({
      sha: 'c2',
      source: 'git',
      workingTree: { 'a.ts': 'dirty', 'b.ts': '<deleted>', 'new.ts': 'n1' },
    })
    expect(
      await run(projects, (b) => b.capture('/p', ['new.ts'])),
    ).toMatchObject({
      workingTree: { 'a.ts': 'dirty', 'b.ts': '<deleted>' },
    })
  })

  test('changedSince compares against the recorded tree', async () => {
    const p = project()
    const projects = new Map([['/p', p]])
    const baseline = (await run(projects, (b) => b.capture('/p', [])))!
    expect(baseline.workingTree).toEqual({})
    expect(
      await run(projects, (b) => b.changedSince('/p', baseline, [])),
    ).toEqual([])
    p.files['a.ts'] = 'edited'
    expect(
      await run(projects, (b) => b.changedSince('/p', baseline, [])),
    ).toEqual(['a.ts'])
    expect(
      await run(projects, (b) => b.changedSince('/p', baseline, ['a.ts'])),
    ).toEqual([])
  })

  test('answers null for unknown or non-ancestor commits and unhashable files', async () => {
    const p = project()
    const projects = new Map([['/p', p]])
    const ahead = { sha: 'c2', source: 'git' as const, workingTree: {} }
    expect(await run(projects, (b) => b.isAncestor('/p', 'c1', 'c2'))).toBe(
      true,
    )
    expect(await run(projects, (b) => b.isAncestor('/p', 'c2', 'c1'))).toBe(
      false,
    )
    expect(await run(projects, (b) => b.isAncestor('/p', 'zz', 'c2'))).toBe(
      false,
    )
    expect(
      await run(projects, (b) =>
        b.changedSince('/p', { ...ahead, sha: 'zz' }, []),
      ),
    ).toBeNull()
    p.files['a.ts'] = '<unavailable>'
    expect(await run(projects, (b) => b.capture('/p', []))).toBeNull()
    expect(
      await run(projects, (b) => b.changedSince('/p', ahead, [])),
    ).toBeNull()
  })

  test('a project without commits has a filesystem baseline', async () => {
    const projects = new Map<string, MemoryProject>([
      [
        '/fs',
        {
          commits: [],
          files: { 'x.ts': 'h', 'vite.config.ts.timestamp-1-a.mjs': 'tmp' },
        },
      ],
    ])
    expect(await run(projects, (b) => b.currentSha('/fs'))).toBeNull()
    expect(await run(projects, (b) => b.capture('/fs', []))).toEqual({
      sha: '',
      source: 'filesystem',
      workingTree: { 'x.ts': 'h' },
    })
  })

  test('the empty layer treats every root as an empty directory', async () => {
    const baseline = await Effect.runPromise(
      Effect.flatMap(Baselines, (b) => b.capture('/anywhere', [])).pipe(
        Effect.provide(BaselinesMemory),
      ),
    )
    expect(baseline).toEqual({ sha: '', source: 'filesystem', workingTree: {} })
  })
})
