import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

import { execute } from '../../src/cli/main.ts'
import { TIA_ADAPTER_CONFORMANCE_SCENARIOS } from '../../src/core/conformance.ts'
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

/** Every scenario a static-impact adapter needs; `code` overrides some. */
function fullSpec(code: Record<string, string>, timeoutMs?: number) {
  return {
    ...spec({}),
    scenarios: TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
      (item) =>
        item.feature === undefined && item.capabilityLevels === undefined,
    ).map(({ id }) => ({
      arguments: ['-e', code[id] ?? 'process.exit(0)'],
      command: process.execPath,
      fixture: `fixtures/${id}`,
      id,
      ...(timeoutMs === undefined || code[id] === undefined
        ? {}
        : { timeoutMs }),
    })),
  }
}

async function certify(args: readonly string[]) {
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    const outcome = await execute(['certify', 'execute', ...args])
    return {
      outcome,
      stderr: write.mock.calls.map(([chunk]) => String(chunk)).join(''),
    }
  } finally {
    write.mockRestore()
  }
}

describe('tiacore certify execute', () => {
  test('says on stderr why scenarios failed when the receipt goes to a file', async () => {
    const root = scratch()
    const path = join(root, 'spec.json')
    const receipt = join(root, 'out', 'receipt.json')
    writeFileSync(
      path,
      JSON.stringify(
        fullSpec(
          {
            'baseline-full':
              'console.log("first"); console.error("\\u001b[31mboom\\u001b[0m\\n"); process.exit(2)',
            'no-change-skip': 'setInterval(() => {}, 1000)',
          },
          1_000,
        ),
      ),
    )
    const { outcome, stderr } = await certify([
      '--spec',
      path,
      '--output',
      receipt,
    ])
    expect(outcome).toEqual({ code: 1, silent: true })
    expect(stderr).toBe(
      `TIA adapter certification failed scenarios: baseline-full, no-change-skip (baseline-full exited with code 2: boom; no-change-skip timed out after 1000 ms); see ${receipt}\n`,
    )
    expect(
      JSON.parse(readFileSync(receipt, 'utf8')).scenarios[0],
    ).toMatchObject({ id: 'baseline-full', passed: false })
  })

  test('stays silent on stderr when the receipt goes to stdout', async () => {
    const root = scratch()
    const path = join(root, 'spec.json')
    writeFileSync(
      path,
      JSON.stringify(fullSpec({ 'baseline-full': 'process.exit(2)' })),
    )
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      const { outcome, stderr } = await certify(['--spec', path])
      expect(outcome).toEqual({ code: 1, silent: true })
      expect(stderr).toBe('')
    } finally {
      stdout.mockRestore()
    }
  })

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
