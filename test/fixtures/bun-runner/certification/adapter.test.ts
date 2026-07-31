import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from 'bun:test'

function run(root: string) {
  return Bun.spawnSync({
    cmd: ['bun', 'run-tia.ts'],
    cwd: root,
    stderr: 'pipe',
    stdout: 'pipe',
  })
}

test('the installed Bun adapter records once and replays from cache', () => {
  const root = resolve(import.meta.dir, '..')
  rmSync(resolve(root, '.tia'), { force: true, recursive: true })
  rmSync(resolve(root, 'executions.log'), { force: true })

  const initial = run(root)
  expect(
    initial.exitCode,
    `${initial.stdout.toString()}${initial.stderr.toString()}`,
  ).toBe(0)

  const replay = run(root)
  const replayOutput = `${replay.stdout.toString()}${replay.stderr.toString()}`
  expect(replay.exitCode, replayOutput).toBe(0)
  expect(replayOutput).toContain('no affected test files')
  expect(
    readFileSync(resolve(root, 'executions.log'), 'utf8')
      .trim()
      .split('\n')
      .sort(),
  ).toEqual(['bun-a', 'bun-b'])
})
