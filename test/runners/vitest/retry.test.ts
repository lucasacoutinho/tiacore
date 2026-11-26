import { afterEach, expect, test } from 'vitest'

import {
  cleanupProjects,
  createProject,
  readGraph,
  runVitest,
} from '../../support/integration-project.ts'

afterEach(() => {
  cleanupProjects()
})

test('a retried test depends on what every attempt touched', async () => {
  const root = createProject({
    testA: `import { expect, test } from 'vitest'

let attempt = 0
test('flaky', { retry: 1 }, async () => {
  attempt += 1
  if (attempt === 1) {
    const { a } = await import('../src/a')
    expect(a()).toBe('not a')
  }
  const { b } = await import('../src/b')
  expect(b()).toBe('b')
})
`,
  })

  const run = runVitest(root)
  expect(run.status, run.output).toBe(0)
  const graph = await readGraph(root)
  expect(graph.edges['test/a.test.ts']).toEqual(
    expect.arrayContaining(['src/a.ts', 'src/b.ts']),
  )
})
