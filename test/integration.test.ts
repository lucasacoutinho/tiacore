import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createProject,
  executions,
  readGraph,
  resetExecutions,
  runVitest,
} from './helpers/integration-project.js'

afterEach(() => {
  cleanupProjects()
})

describe('Vitest integration', () => {
  test('records runtime edges, selects a dynamic-import consumer, and replays the rest', () => {
    const root = createProject()

    const first = runVitest(root)
    expect(first.status, first.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'b'])
    expect(first.output).toContain('TIA recording full-suite baseline')

    const graph = readGraph(root)
    expect(graph.edges['test/a.test.ts']).toContain('src/a.ts')
    expect(graph.coverageComplete).toBe(true)
    expect(
      Object.values(graph.testCoverage).flatMap((coverage) =>
        Object.keys(coverage),
      ),
    ).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']))

    resetExecutions(root)
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const second = runVitest(root)
    expect(second.status, second.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
    expect(second.output).toContain(
      'TIA replay: 1 affected test case in 1 test file',
    )
    expect(second.output).toContain('1 cached test result')

    resetExecutions(root)
    const third = runVitest(root)
    expect(third.status, third.output).toBe(0)
    expect(executions(root)).toEqual([])
    expect(third.output).toContain('TIA replay: no affected test files')
  })
})
