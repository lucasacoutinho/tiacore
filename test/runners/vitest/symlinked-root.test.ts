import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import {
  cleanupProjects,
  createSiblingWorkspace,
  executions,
  resetExecutions,
  runVitest,
  symlinkTo,
} from '../../support/integration-project.ts'

// git prints the repository top with symlinks resolved. With
// resolve.preserveSymlinks, Vite keeps a root reached through a symlink as
// given and names its modules under it, so a sibling package must still be
// tracked under the root's own spelling.

afterEach(() => {
  cleanupProjects()
})

test.each(['full', 'ignore'] as const)(
  'a sibling-package edit selects its test when the root is reached through a symlink (onUnknownChange: %s)',
  (onUnknownChange) => {
    const { packageDir, repo } = createSiblingWorkspace({
      config: 'resolve: { preserveSymlinks: true },',
      pluginOptions: `{ log: true, onUnknownChange: '${onUnknownChange}' }`,
    })
    const args = ['run', '--root', join(symlinkTo(repo), 'packages/a')]

    const recorded = runVitest(packageDir, args)
    expect(recorded.status, recorded.output).toBe(0)
    expect(executions(packageDir).sort()).toEqual(['other', 'use'])

    resetExecutions(packageDir)
    writeFileSync(
      join(repo, 'packages/b/src/value.ts'),
      'export const value = () => 1\n// sibling edit\n',
    )

    const selected = runVitest(packageDir, args)
    expect(selected.status, selected.output).toBe(0)
    expect(selected.output).not.toContain('unknown to the graph')
    expect(executions(packageDir)).toEqual(['use'])
  },
)
