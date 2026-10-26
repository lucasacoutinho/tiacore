import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import {
  cleanupProjects,
  createSiblingWorkspace,
  executions,
  resetExecutions,
  runVitest,
} from '../../support/integration-project.ts'

afterEach(() => {
  cleanupProjects()
})

test('a sibling-package edit selects only the tests that import it', () => {
  const { packageDir, repo } = createSiblingWorkspace()

  const recorded = runVitest(packageDir)
  expect(recorded.status, recorded.output).toBe(0)
  expect(executions(packageDir).sort()).toEqual(['other', 'use'])
  expect(recorded.output).toContain('TIA recording full-suite baseline')

  resetExecutions(packageDir)
  writeFileSync(
    join(repo, 'packages/b/src/value.ts'),
    'export const value = () => 1\n// sibling edit\n',
  )

  const selected = runVitest(packageDir)
  expect(selected.status, selected.output).toBe(0)
  expect(selected.output).not.toContain('unknown to the graph')
  expect(executions(packageDir)).toEqual(['use'])

  resetExecutions(packageDir)
  writeFileSync(
    join(repo, 'packages/b/src/unused.ts'),
    'export const unused = () => 0\n// untracked sibling\n',
  )

  const expanded = runVitest(packageDir)
  expect(expanded.status, expanded.output).toBe(0)
  expect(expanded.output).toContain(
    'changed file is unknown to the graph: ../b/src/unused.ts',
  )
  expect(executions(packageDir).sort()).toEqual(['other', 'use'])
})
