import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaVerificationReceipt } from '../../../src/verification/types.js'
import {
  cleanupProjects,
  createFixtureProject,
  executions,
  packageRoot,
  resetExecutions,
  runCommand,
} from '../../helpers/integration-project.js'

afterEach(() => {
  cleanupProjects()
})

describe('verification CLI', () => {
  test('compares a selective Node run with a fresh full run', () => {
    const root = createFixtureProject('node-runner')
    const baseline = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(baseline.status, baseline.output).toBe(0)
    resetExecutions(root)
    writeFileSync(
      join(root, 'src/a.mjs'),
      "export const a = () => 'a'\n\n",
    )

    const result = runCommand(
      root,
      process.execPath,
      [
        join(packageRoot, 'dist/entries/cli.js'),
        'verify',
        '--output',
        'verification.json',
        '--',
        process.execPath,
        'run-tia.mjs',
      ],
      60_000,
    )

    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual([
      'node-a',
      'node-a',
      'node-b',
    ])
    const receipt = JSON.parse(
      readFileSync(join(root, 'verification.json'), 'utf8'),
    ) as TiaVerificationReceipt
    expect(receipt).toMatchObject({
      performance: {
        executionReduction: 0.5,
        fallbacks: [],
        fullExecutedTests: 2,
        selectiveExecutedTests: 1,
        selectiveReplayedTests: 2,
      },
      schema: 1,
      success: true,
      verified: true,
    })
    expect(receipt.runners).toEqual([
      expect.objectContaining({ runner: 'node', verified: true }),
    ])
    expect(receipt.phases.selective.runners).toEqual(['node'])
    expect(receipt.phases.full.runners).toEqual(['node'])
    expect(receipt.phases.selective.metrics).toEqual([
      expect.objectContaining({
        executedTests: 1,
        mode: 'replay',
        replayedTests: 2,
        runner: 'node',
      }),
    ])
    expect(receipt.performance.speedup).toBeGreaterThan(0)
  })
})
