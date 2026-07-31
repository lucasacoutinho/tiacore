import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  executions,
  runCommand,
} from '../../helpers/integration-project.js'

interface Span {
  end: number
  start: number
}

function overlap(root: string, left: string, right: string): boolean {
  const first = JSON.parse(
    readFileSync(join(root, 'spans', `${left}.json`), 'utf8'),
  ) as Span
  const second = JSON.parse(
    readFileSync(join(root, 'spans', `${right}.json`), 'utf8'),
  ) as Span
  return first.start < second.end && second.start < first.end
}

afterEach(cleanupProjects)

describe('bounded runner parallelism', () => {
  test('observes separate node:test files concurrently', () => {
    const root = createFixtureProject('node-parallel')
    const result = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      20_000,
      { TIA_CONCURRENCY: '2', TIA_EXPECT_PARALLEL: '1' },
    )

    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['node-a', 'node-b'])
    expect(overlap(root, 'node-a', 'node-b')).toBe(true)

    const serialRoot = createFixtureProject('node-parallel')
    const serial = runCommand(
      serialRoot,
      process.execPath,
      ['run-tia.mjs'],
      20_000,
      { TIA_CONCURRENCY: '1' },
    )
    expect(serial.status, serial.output).toBe(0)
    expect(overlap(serialRoot, 'node-a', 'node-b')).toBe(false)
  })

  test('observes separate bun:test files concurrently', () => {
    const root = createFixtureProject('bun-parallel')
    const result = runCommand(
      root,
      'bun',
      ['run-tia.ts'],
      20_000,
      { TIA_CONCURRENCY: '2', TIA_EXPECT_PARALLEL: '1' },
    )

    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['bun-a', 'bun-b'])
    expect(overlap(root, 'bun-a', 'bun-b')).toBe(true)

    const serialRoot = createFixtureProject('bun-parallel')
    const serial = runCommand(
      serialRoot,
      'bun',
      ['run-tia.ts'],
      20_000,
      { TIA_CONCURRENCY: '1' },
    )
    expect(serial.status, serial.output).toBe(0)
    expect(overlap(serialRoot, 'bun-a', 'bun-b')).toBe(false)
  })
})
