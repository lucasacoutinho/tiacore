import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'

import { Baselines } from '../../../src/engine/ports.ts'
import { EngineLive } from '../support/layers.ts'
import { cleanupScratch, put, repository, scratch } from '../support/repos.ts'

// BASE-GIT-01: any git failure (non-zero exit, git missing, output over
// 20 MiB) yields null, never an error.

const run = <A>(program: Effect.Effect<A, never, Baselines>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(EngineLive)))

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
  cleanupScratch()
})

function shim(script: string): string {
  const directory = scratch('tia-shim-')
  const binary = join(directory, 'git')
  mkdirSync(directory, { recursive: true })
  writeFileSync(binary, `#!/bin/sh\n${script}\n`)
  chmodSync(binary, 0o755)
  return directory
}

describe('git failures', () => {
  test('a missing git falls back to a filesystem baseline', async () => {
    const root = repository({ 'src/a.ts': 'a\n' })
    process.env.PATH = scratch('tia-empty-')
    const baseline = await run(
      Effect.flatMap(Baselines, (b) => b.capture(root, [])),
    )
    expect(baseline).toMatchObject({ sha: '', source: 'filesystem' })
    expect(Object.keys(baseline?.workingTree ?? {})).toContain('src/a.ts')
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(root))),
    ).toBeNull()
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.isAncestor(root, 'a', 'b'))),
    ).toBe(false)
  })

  test('output beyond 20 MiB is treated as a failure', async () => {
    const root = repository({ 'src/a.ts': 'a\n' })
    put(root, 'src/dirty.ts')
    process.env.PATH = `${shim(
      'case "$*" in *--is-inside-work-tree*) printf "true\\n%s\\n0123456789012345678901234567890123456789\\n" "$PWD";; *) head -c 22000000 /dev/zero | tr "\\0" "a";; esac',
    )}:${originalPath}`
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.capture(root, []))),
    ).toBeNull()
  })

  test('a non-zero exit is a failure', async () => {
    const root = repository({ 'src/a.ts': 'a\n' })
    process.env.PATH = `${shim('exit 3')}:${originalPath}`
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(root))),
    ).toBeNull()
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.isAncestor(root, 'a', 'b'))),
    ).toBe(false)
  })

  test('passes quotepath off, runs in the project root and ignores stdin', async () => {
    const root = repository({ 'src/a.ts': 'a\n' })
    const log = join(scratch('tia-log-'), 'calls.txt')
    process.env.PATH = `${shim(`echo "$PWD|$*" >> ${log}; cat > /dev/null; printf 'true\\n/top\\nabc\\n'`)}:${originalPath}`
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(root))),
    ).toBe('abc')
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(log, 'utf8').trim()).toBe(
      `${root}|-c core.quotepath=false rev-parse --is-inside-work-tree --show-toplevel --verify HEAD`,
    )
  })

  test('an answer it cannot read falls back to asking for HEAD alone', async () => {
    const root = repository({ 'src/a.ts': 'a\n' })
    const log = join(scratch('tia-log-'), 'calls.txt')
    process.env.PATH = `${shim(`echo "$PWD|$*" >> ${log}; cat > /dev/null; echo abc`)}:${originalPath}`
    expect(
      await run(Effect.flatMap(Baselines, (b) => b.currentSha(root))),
    ).toBe('abc')
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `${root}|-c core.quotepath=false rev-parse --is-inside-work-tree --show-toplevel --verify HEAD`,
      `${root}|-c core.quotepath=false rev-parse --verify HEAD`,
    ])
  })
})
