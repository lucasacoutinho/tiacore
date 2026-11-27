import { symlinkSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'

import type { Baseline } from '../../../src/core/runtime.ts'
import { Baselines } from '../../../src/engine/ports.ts'
import { EngineLive } from '../support/layers.ts'
import { cleanupScratch, put, repository, scratch } from '../support/repos.ts'

// git prints the repository top with symlinks resolved (macOS reaches its
// temporary directory through /var -> /private/var). A project reached
// through a symlink must get the baseline its real path gets, hashes
// included, so a file outside the project is still hashed where it lives.

const run = <A>(program: Effect.Effect<A, never, Baselines>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(EngineLive)))

const capture = (root: string) =>
  run(Effect.flatMap(Baselines, (b) => b.capture(root, [])))
const changedSince = (root: string, baseline: Baseline) =>
  run(Effect.flatMap(Baselines, (b) => b.changedSince(root, baseline, [])))

afterEach(cleanupScratch)

/** A symlink to `target`, in a scratch directory of its own. */
function linkTo(target: string): string {
  const link = join(scratch('tia-link-'), 'project')
  symlinkSync(target, link)
  return link
}

describe('a project root reached through a symlink', () => {
  test('gets the baseline and the changes of its real path', async () => {
    const real = repository({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' })
    put(real, 'src/a.ts', 'dirty\n')
    put(real, 'src/new.ts')
    const link = linkTo(real)
    const baseline = await capture(link)
    expect(baseline).toEqual(await capture(real))
    expect(Object.keys(baseline?.workingTree ?? {})).toEqual([
      'src/a.ts',
      'src/new.ts',
    ])
    put(real, 'src/b.ts', 'edited\n')
    expect(await changedSince(link, baseline!)).toEqual(['src/b.ts'])
  })

  test('to a subdirectory of the repository hashes files outside it where they live', async () => {
    const real = repository({ 'app/src/a.ts': 'a\n', 'other/x.ts': 'x\n' })
    put(real, 'app/src/a.ts', 'dirty\n')
    put(real, 'other/x.ts', 'dirty\n')
    put(real, 'other/new.ts')
    const link = linkTo(join(real, 'app'))
    const baseline = await capture(link)
    expect(baseline).toEqual(await capture(join(real, 'app')))
    expect(Object.keys(baseline?.workingTree ?? {})).toEqual([
      '../other/new.ts',
      '../other/x.ts',
      'src/a.ts',
    ])
    put(real, 'other/x.ts', 'edited\n')
    expect(await changedSince(link, baseline!)).toEqual(['../other/x.ts'])
  })
})
