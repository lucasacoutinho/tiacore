import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { tia } from '../../../src/entries/node.ts'
import type { TiaRunnerResult } from '../../../src/runners/shared/types.ts'
import { legacy } from '../../support/legacy.ts'
import {
  cleanupProjects,
  createFixtureProject,
} from '../../support/runner-project.ts'
import { NODE_DISCOVERY_HOOKS } from '../../support/node-version.ts'

interface LegacyRunner {
  tia: typeof tia
}

afterEach(cleanupProjects)

function shape(result: TiaRunnerResult): object {
  return {
    executed: result.executedTests
      .map((entry) => [entry.id, entry.state, entry.files])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    graphSaved: result.graphSaved,
    mode: result.plan.mode,
    reason: result.plan.reason,
    replayedTests: result.replayedTests,
    success: result.success,
  }
}

// The same fixture through the 1.x runner and the 2.0 runner must observe the
// same cases with the same dependency files. (1.x's CommonJS shim turned
// `test.skip` into a plain test; this fixture is ESM, so both
// agree here, and test/runners/node-shim.test.ts pins the CommonJS case.)
describe('node runner against the 1.x oracle', () => {
  // 1.x and 2.0 both select single cases only with discovery hooks (22.15+).
  test.skipIf(!NODE_DISCOVERY_HOOKS)(
    'record, replay and change observe the same cases and files',
    async () => {
      const oracle = await legacy<LegacyRunner>('entries/node.js')
      const roots = [
        createFixtureProject('node-runner'),
        createFixtureProject('node-runner'),
      ]
      const sides = [oracle.tia, tia]
      const steps: Array<[string, (root: string) => void]> = [
        ['record', () => {}],
        ['replay', () => {}],
        [
          'change a',
          (root) =>
            writeFileSync(
              join(root, 'src/a.mjs'),
              "export const a = () => 'a'\n\n",
            ),
        ],
        [
          'edit the test file',
          (root) =>
            writeFileSync(
              join(root, 'src/b.mjs'),
              "export const b = () => 'b'\n// edit\n",
            ),
        ],
      ]
      for (const [label, mutate] of steps) {
        const shapes: Array<ReturnType<typeof shape>> = []
        for (const [index, make] of sides.entries()) {
          const root = roots[index]!
          mutate(root)
          const result = await make({
            files: ['test/**/*.test.mjs'],
            fresh: false,
            log: false,
            root,
          }).run()
          shapes.push(shape(result))
        }
        expect(shapes[1], label).toEqual(shapes[0])
      }
    },
    120_000,
  )
})
