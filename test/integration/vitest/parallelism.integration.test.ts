import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaRuntimeGraph } from '../../../src/shared/types.js'
import {
  cleanupProjects,
  createFixtureProject,
  executions,
  readGraph,
  resetExecutions,
  runVitest,
} from '../../helpers/integration-project.js'

interface Span {
  end: number
  id: string
  pid: number
  start: number
  threadId: number
}

function comparableGraph(graph: TiaRuntimeGraph): unknown {
  const value = structuredClone(graph)
  value.updatedAt = ''
  for (const result of Object.values(value.results)) {
    delete result.duration
  }
  return value
}

function spans(root: string): Span[] {
  const directory = join(root, 'spans')
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory)
    .sort()
    .map(
      (file) => JSON.parse(readFileSync(join(directory, file), 'utf8')) as Span,
    )
}

function hasOverlap(values: Span[]): boolean {
  return values.some((left, index) =>
    values
      .slice(index + 1)
      .some((right) => left.start < right.end && right.start < left.end),
  )
}

function cleanRuntime(root: string): void {
  rmSync(join(root, '.tia'), { force: true, recursive: true })
  rmSync(join(root, 'spans'), { force: true, recursive: true })
  writeFileSync(join(root, 'executions.log'), '')
}

afterEach(cleanupProjects)

describe('Vitest worker parallelism', () => {
  for (const pool of ['threads', 'forks'] as const) {
    test(`matches serial dependency and coverage graphs in the ${pool} pool`, () => {
      const root = createFixtureProject('parallel-vitest')
      const serial = runVitest(
        root,
        ['run', `--pool=${pool}`, '--maxWorkers=1'],
        30_000,
      )
      expect(serial.status, serial.output).toBe(0)
      const expected = comparableGraph(readGraph(root))

      for (let schedule = 0; schedule < 2; schedule += 1) {
        cleanRuntime(root)
        const parallel = runVitest(
          root,
          ['run', `--pool=${pool}`, '--maxWorkers=4'],
          30_000,
        )
        expect(parallel.status, parallel.output).toBe(0)
        expect(comparableGraph(readGraph(root))).toEqual(expected)
        expect(executions(root)).toHaveLength(16)
        expect(hasOverlap(spans(root))).toBe(true)
        expect(
          new Set(spans(root).map((span) => `${span.pid}:${span.threadId}`))
            .size,
        ).toBeGreaterThan(1)
      }

      resetExecutions(root)
      rmSync(join(root, 'spans'), { force: true, recursive: true })
      writeFileSync(
        join(root, 'src/group-3.ts'),
        'export const value = (input: number): number => input + 3\n\n',
      )

      const affected = runVitest(
        root,
        ['run', `--pool=${pool}`, '--maxWorkers=4'],
        30_000,
      )
      expect(affected.status, affected.output).toBe(0)
      expect(executions(root).sort()).toEqual(['03', '07', '11', '15'])
    })
  }
})
