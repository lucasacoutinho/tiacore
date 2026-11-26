import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { execute } from '../../src/cli/main.ts'
import { disposeHost } from '../../src/host/runtime.ts'

afterAll(disposeHost)

const directories: string[] = []
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-certify-cli-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { force: true, recursive: true })
})

function spec(scenario: Record<string, unknown>) {
  return {
    adapter: 'fixture-static',
    capabilityLevel: 'static-impact',
    runner: { name: 'node', version: process.versions.node },
    scenarios: [
      {
        arguments: ['-e', 'process.exit(0)'],
        command: process.execPath,
        fixture: 'test/fixtures/x',
        id: 'baseline-full',
        ...scenario,
      },
    ],
    selectionGranularity: 'test-file',
    sourceRevision: 'sha256:fixture',
  }
}

describe('tiacore certify execute', () => {
  test.each([1.5, -1])(
    'rejects %s assertions before running anything',
    async (assertions) => {
      const root = scratch()
      const path = join(root, 'spec.json')
      const marker = join(root, 'ran')
      writeFileSync(
        path,
        JSON.stringify(
          spec({
            arguments: [
              '-e',
              `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`,
            ],
            assertions,
          }),
        ),
      )
      const outcome = await execute(['certify', 'execute', '--spec', path])
      expect(outcome.code).toBe(1)
      expect(outcome.message).toMatch(
        /^TIA certification specification scenarios\[0\]\.assertions /u,
      )
      expect(() => readFileSync(marker)).toThrow(/ENOENT/u)
    },
  )
})
