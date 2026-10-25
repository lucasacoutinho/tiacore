import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  executions,
  runCommand,
} from '../../support/runner-project.ts'

interface Span {
  end: number
  start: number
}

function span(root: string, name: string): Span {
  return JSON.parse(readFileSync(join(root, 'spans', `${name}.json`), 'utf8'))
}

function overlap(root: string, left: string, right: string): boolean {
  const first = span(root, left)
  const second = span(root, right)
  return first.start < second.end && second.start < first.end
}

afterEach(cleanupProjects)

const hasBun = runCommand(process.cwd(), 'bun', ['--version']).status === 0

describe('bounded runner parallelism', () => {
  test('observes separate node:test files concurrently', () => {
    const root = createFixtureProject('node-parallel')
    const result = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000, {
      TIA_CONCURRENCY: '2',
      TIA_EXPECT_PARALLEL: '1',
    })

    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['node-a', 'node-b'])
    expect(overlap(root, 'node-a', 'node-b')).toBe(true)

    const serialRoot = createFixtureProject('node-parallel')
    const serial = runCommand(
      serialRoot,
      process.execPath,
      ['run-tia.mjs'],
      30_000,
      { TIA_CONCURRENCY: '1' },
    )
    expect(serial.status, serial.output).toBe(0)
    expect(overlap(serialRoot, 'node-a', 'node-b')).toBe(false)
  })

  test.skipIf(!hasBun)('observes separate bun:test files concurrently', () => {
    const root = createFixtureProject('bun-parallel')
    const result = runCommand(root, 'bun', ['run-tia.ts'], 30_000, {
      TIA_CONCURRENCY: '2',
      TIA_EXPECT_PARALLEL: '1',
    })

    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['bun-a', 'bun-b'])
    expect(overlap(root, 'bun-a', 'bun-b')).toBe(true)

    const serialRoot = createFixtureProject('bun-parallel')
    const serial = runCommand(serialRoot, 'bun', ['run-tia.ts'], 30_000, {
      TIA_CONCURRENCY: '1',
    })
    expect(serial.status, serial.output).toBe(0)
    expect(overlap(serialRoot, 'bun-a', 'bun-b')).toBe(false)
  })
})
