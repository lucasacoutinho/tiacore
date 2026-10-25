import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  executions,
  readGraph,
  resetExecutions,
  runCommand,
} from '../../support/runner-project.ts'

// Ports of the runner cases of 1.x test/integration/storage/failure-injection:
// a killed or crashing child must never drop healthy files or corrupt state.

const temporaryDirectories: string[] = []
const hasBun = runCommand(process.cwd(), 'bun', ['--version']).status === 0

afterEach(() => {
  cleanupProjects()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('runner failure injection', () => {
  test('records a killed Node coverage worker as a failure and recovers it', async () => {
    const root = createFixtureProject('node-worker-crash')
    const initial = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(initial.status, initial.output).toBe(0)

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/value.mjs'),
      "export const value = () => 'stable'\n// changed\n",
    )
    const crashed = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      30_000,
      { TIACORE_INJECT_WORKER_CRASH: '1' },
    )
    expect(crashed.status, crashed.output).toBe(1)
    expect(Object.values((await readGraph(root, 'node')).results)).toEqual([
      expect.objectContaining({
        fullName: 'test/crash.test.mjs (module failure)',
        state: 'failed',
      }),
    ])

    resetExecutions(root)
    const recovered = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(recovered.status, recovered.output).toBe(0)
    expect(executions(root)).toEqual(['worker'])
    expect(Object.values((await readGraph(root, 'node')).results)).toEqual([
      expect.objectContaining({
        fullName: 'worker crash case',
        state: 'passed',
      }),
    ])
  })

  test.skipIf(!hasBun)(
    'records one crashing Bun module without dropping healthy files',
    async () => {
      const root = createFixtureProject('bun-parallel')
      writeFileSync(
        join(root, 'test/a.test.ts'),
        "throw new Error('injected Bun module failure')\n",
      )

      const failed = runCommand(root, 'bun', ['run-tia.ts'])

      expect(failed.status, failed.output).toBe(1)
      expect(executions(root)).toEqual(['bun-b'])
      expect(Object.values((await readGraph(root, 'bun')).results)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fullName: 'test/a.test.ts (module failure)',
            state: 'failed',
          }),
          expect.objectContaining({
            fullName: 'parallel bun b',
            state: 'passed',
          }),
        ]),
      )
    },
  )

  test.skipIf(!hasBun)(
    'fails closed when a Bun case crashes after discovery',
    async () => {
      const root = createFixtureProject('bun-parallel')
      const markerDirectory = mkdtempSync(join(tmpdir(), 'tiacore-bun-marker-'))
      temporaryDirectories.push(markerDirectory)
      const marker = join(markerDirectory, 'discovered')
      writeFileSync(
        join(root, 'test/a.test.ts'),
        `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { value } from '../src/a'

const marker = process.env.TIACORE_INJECT_BUN_MARKER
if (marker) {
  if (existsSync(marker)) {
    process.exit(42)
  }
  writeFileSync(marker, 'discovered')
}

test('parallel bun a', () => {
  appendFileSync('executions.log', 'bun-a\\n')
  expect(value).toBe('a')
})
`,
      )

      const failed = runCommand(root, 'bun', ['run-tia.ts'], 30_000, {
        TIACORE_INJECT_BUN_MARKER: marker,
      })

      expect(failed.status, failed.output).toBe(1)
      expect(executions(root)).toEqual(['bun-b'])
      expect(Object.values((await readGraph(root, 'bun')).results)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fullName: 'test/a.test.ts (module failure)',
            state: 'failed',
          }),
        ]),
      )
    },
  )
})
