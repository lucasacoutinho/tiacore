import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { execute } from '../../src/cli/main.ts'
import { disposeHost } from '../../src/host/runtime.ts'

afterAll(disposeHost)

const directories: string[] = []
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-cli-commands-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { force: true, recursive: true })
})

function planInputs(root: string) {
  const catalog = join(root, 'catalog.json')
  const changes = join(root, 'changes.json')
  writeFileSync(
    catalog,
    JSON.stringify([
      {
        adapter: 'k6',
        file: 'profiles/smoke.js',
        id: 'k6:smoke',
        project: 'load',
      },
    ]),
  )
  writeFileSync(changes, JSON.stringify(['src/health.ts']))
  return [
    'plan',
    '--catalog',
    catalog,
    '--changes',
    changes,
    '--environment-fingerprint',
    'local',
    '--fingerprint',
    'project',
  ]
}

describe('tiacore plan', () => {
  test('creates the directories of an --output path', async () => {
    const root = scratch()
    const output = join(root, 'reports', 'tia', 'plan.json')
    const outcome = await execute([...planInputs(root), '--output', output])
    expect(outcome).toEqual({ code: 0 })
    expect(JSON.parse(readFileSync(output, 'utf8'))).toHaveProperty('selected')
  })

  test('names the policy field that does not decode', async () => {
    const root = scratch()
    const policy = join(root, 'policy.json')
    writeFileSync(policy, JSON.stringify({ forceFull: 'yes' }))
    const outcome = await execute([...planInputs(root), '--policy', policy])
    expect(outcome.code).toBe(1)
    expect(outcome.message).toBe(
      'TIA execution policy forceFull Expected boolean',
    )
  })
})
