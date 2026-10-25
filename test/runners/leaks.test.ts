import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

import { inheritedEnvironment, runProcess } from '../../src/engine/process.ts'
import { runPromise } from '../../src/host/runtime.ts'
import { tia as adapterTia } from '../../src/entries/adapter.ts'
import { tia as nodeTia } from '../../src/entries/node.ts'
import { assertNoLeak } from '../support/leak.ts'
import { initRepository } from '../support/runner-project.ts'

// NF-MEM: a long-lived process that runs a runner over and over (watch mode,
// a CI agent, a workspace lane loop) retains nothing per run.

const directories: string[] = []

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-runner-leak-'))
  directories.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'test'))
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1\n')
  writeFileSync(
    join(root, 'test/value.test.mjs'),
    "import test from 'node:test'\ntest('value', () => {})\n",
  )
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, '.gitignore'), '.tia/\n')
  initRepository(root)
  return root
}

describe('memory', () => {
  test('repeated child processes retain nothing', async () => {
    const options = { bytesPerOperation: 8_192, iterations: 20 }
    const result = await assertNoLeak(
      () =>
        runPromise(
          runProcess({
            args: ['-e', 'process.exit(0)'],
            command: process.execPath,
            cwd: process.cwd(),
            env: inheritedEnvironment(),
            stdio: 'capture',
            timeoutMs: 10_000,
          }),
        ),
      options,
    )
    expect(result.bytesPerOperation).toBeLessThan(options.bytesPerOperation)
  }, 120_000)

  test('repeated replay runs of the node runner retain nothing', async () => {
    const root = project()
    const options = { files: ['test/**/*.test.mjs'], log: false, root }
    // Record once; every later run replays from cache without a child process.
    expect((await nodeTia(options).run()).success).toBe(true)
    expect(
      await assertNoLeak(
        async () => {
          const result = await nodeTia(options).run()
          expect(result.plan.mode).toBe('replay')
        },
        { bytesPerOperation: 40_000, iterations: 10 },
      ),
    ).toBeDefined()
  }, 180_000)

  test('repeated adapter runs retain nothing', async () => {
    const root = project()
    const definition = {
      apiVersion: 1 as const,
      discover: () => ({
        tests: [{ file: 'test/value.test.mjs', fullName: 'v', id: 'v' }],
      }),
      execute: () => ({
        complete: true,
        observations: [
          {
            file: 'test/value.test.mjs',
            files: ['src/value.mjs'],
            fullName: 'v',
            id: 'v',
            state: 'passed' as const,
          },
        ],
      }),
      name: 'leak-adapter',
      version: '1',
    }
    await adapterTia(definition, { log: false, root }).run()
    const result = await assertNoLeak(
      async () => {
        await adapterTia(definition, { log: false, root }).run()
      },
      { bytesPerOperation: 40_000, iterations: 10 },
    )
    expect(result.bytesPerOperation).toBeLessThan(40_000)
  }, 180_000)
})
