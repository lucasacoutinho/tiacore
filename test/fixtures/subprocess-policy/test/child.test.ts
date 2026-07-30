import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { expect, test } from 'vitest'

test('runs an external Node process', () => {
  appendFileSync('executions.log', 'child\n')
  const output = execFileSync(
    process.execPath,
    [resolve(process.cwd(), 'src/child.mjs')],
    { encoding: 'utf8' },
  )
  expect(output).toBe('child-v1')
})
