import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { TiaVerificationReceipt } from '../../src/core/verification.ts'
import {
  cleanupProjects as cleanupVitestProjects,
  createProject,
  packageRoot,
  runVitest,
} from '../support/integration-project.ts'
import {
  cleanupProjects,
  createFixtureProject,
  executions,
  resetExecutions,
  runCommand,
} from '../support/runner-project.ts'

afterEach(() => {
  cleanupProjects()
  cleanupVitestProjects()
})

const cli = join(packageRoot, 'dist/entries/cli.js')

describe('verification CLI', () => {
  test('compares a selective Node run with a fresh full run', () => {
    const root = createFixtureProject('node-runner')
    const baseline = runCommand(root, process.execPath, ['run-tia.mjs'])
    expect(baseline.status, baseline.output).toBe(0)
    resetExecutions(root)
    writeFileSync(join(root, 'src/a.mjs'), "export const a = () => 'a'\n\n")

    const result = runCommand(
      root,
      process.execPath,
      [
        cli,
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
    expect(executions(root).sort()).toEqual(['node-a', 'node-a', 'node-b'])
    const receipt: TiaVerificationReceipt = JSON.parse(
      readFileSync(join(root, 'verification.json'), 'utf8'),
    )
    expect(receipt).toMatchObject({
      accuracy: {
        executedTests: 1,
        expectedTests: 1,
        falseNegativeRate: 0,
        missedTests: 0,
        precision: 1,
        unnecessaryTests: 0,
      },
      performance: {
        executionReduction: 0.5,
        fallbacks: [],
        fullExecutedTests: 2,
        selectiveExecutedTests: 1,
        selectiveReplayedTests: 2,
      },
      schema: 2,
      success: true,
      verified: true,
    })
    expect(receipt.runners).toEqual([
      expect.objectContaining({
        runner: 'node',
        selection: expect.objectContaining({
          executedTestIds: expect.arrayContaining([
            expect.stringContaining('node case a'),
          ]),
          expectedTestIds: expect.arrayContaining([
            expect.stringContaining('node case a'),
          ]),
          falseNegativeRate: 0,
          missedTestIds: [],
        }),
        verified: true,
      }),
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

  test('compares a selective Vitest run with a fresh full run', () => {
    const root = createProject()
    const baseline = runVitest(root, ['run'], 60_000)
    expect(baseline.status, baseline.output).toBe(0)
    writeFileSync(join(root, 'executions.log'), '')
    writeFileSync(join(root, 'src/a.ts'), "export const a = () => 'a'\n\n")

    const result = runCommand(
      root,
      process.execPath,
      [
        cli,
        'verify',
        '--output',
        'verification.json',
        '--',
        process.execPath,
        join(packageRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
      ],
      90_000,
    )

    expect(result.status, result.output).toBe(0)
    expect(executions(root).sort()).toEqual(['a', 'a', 'b'])
    const receipt: TiaVerificationReceipt = JSON.parse(
      readFileSync(join(root, 'verification.json'), 'utf8'),
    )
    expect(receipt).toMatchObject({
      accuracy: { executedTests: 1, expectedTests: 1, missedTests: 0 },
      success: true,
      verified: true,
    })
    expect(receipt.runners).toHaveLength(1)
    expect(receipt.runners[0]?.runner).toMatch(/^vitest:/u)
    expect(receipt.phases.selective.metrics[0]).toMatchObject({
      executedTests: 1,
      mode: 'replay',
    })
  })

  test('a failing selective run exits 1 with the receipt on stdout', () => {
    const root = createFixtureProject('node-runner')
    const result = runCommand(
      root,
      process.execPath,
      [cli, 'verify', '--', process.execPath, '-e', 'process.exit(0)'],
      60_000,
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.output)).toMatchObject({
      issues: [{ code: 'snapshot-invalid' }],
      success: false,
    })
  })
})
