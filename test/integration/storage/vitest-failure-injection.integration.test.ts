import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createProject,
  executions,
  resetExecutions,
  runVitest,
} from '../../support/integration-project.ts'

// The Vitest case of failure injection. The other cases are in
// storage.integration.test.ts and
// test/integration/runners/failure-injection.integration.test.ts.

afterEach(cleanupProjects)

describe('Vitest failure injection', () => {
  test('preserves the previous Vitest graph when a fork worker exits', () => {
    const root = createProject({
      testA: `import { appendFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { a } from '../src/a'

test('worker exit case', () => {
  appendFileSync(new URL('../executions.log', import.meta.url), 'a\\n')
  if (process.env.TIACORE_INJECT_VITEST_EXIT === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
  expect(a()).toBe('a')
})
`,
    })
    const initial = runVitest(root, ['run', '--pool=forks'])
    expect(initial.status, initial.output).toBe(0)
    const stateFile = join(root, '.tia/state.json')
    const before = readFileSync(stateFile, 'utf8')

    resetExecutions(root)
    writeFileSync(
      join(root, 'src/a.ts'),
      "export const a = () => 'a'\n// changed\n",
    )
    const crashed = runVitest(root, ['run', '--pool=forks'], 20_000, {
      TIACORE_INJECT_VITEST_EXIT: '1',
    })
    expect(crashed.status).not.toBe(0)
    expect(readFileSync(stateFile, 'utf8')).toBe(before)

    resetExecutions(root)
    const recovered = runVitest(root, ['run', '--pool=forks'])
    expect(recovered.status, recovered.output).toBe(0)
    expect(executions(root)).toEqual(['a'])
  })
})
