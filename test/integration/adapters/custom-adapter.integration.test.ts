import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  executions,
  runCommand,
} from '../../helpers/integration-project.js'

afterEach(cleanupProjects)

describe('external TypeScript adapter package contract', () => {
  test('uses the public adapter entry point for full, replay, and changed runs', () => {
    const root = createFixtureProject('custom-adapter')

    const first = runCommand(root, process.execPath, ['run.mjs'])
    expect(first.status, first.output).toBe(0)
    expect(first.output).toContain('"mode":"record"')

    const replay = runCommand(root, process.execPath, ['run.mjs'])
    expect(replay.status, replay.output).toBe(0)
    expect(replay.output).toContain('"selectedTests":0')

    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 2\n')
    const changed = runCommand(root, process.execPath, ['run.mjs'])
    expect(changed.status, changed.output).toBe(0)
    expect(changed.output).toContain('"selectedTests":1')
    expect(executions(root)).toEqual([
      'external:value:1',
      'external:value:2',
    ])
  })
})
