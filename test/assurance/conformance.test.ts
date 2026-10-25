import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, test } from 'vitest'

import {
  TIA_ADAPTER_CONFORMANCE_SCENARIOS,
  certifyAdapterReceipt,
  executeAdapterCertification,
  parseAdapterCertificationReceipt,
  type TiaAdapterCertificationReceipt,
} from '../../src/entries/conformance.ts'
import { legacy } from '../support/legacy.ts'

function receipt(): TiaAdapterCertificationReceipt {
  return {
    adapter: 'example-node',
    capabilityLevel: 'runtime-tia',
    contractVersion: 1,
    environment: {
      architecture: 'x64',
      operatingSystem: 'linux',
    },
    features: [],
    generatedAt: '2026-07-30T00:00:00.000Z',
    protocolVersion: 1,
    runner: {
      name: 'example',
      version: '1.0.0',
    },
    scenarios: TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
      (scenario) =>
        scenario.feature === undefined &&
        (scenario.capabilityLevels === undefined ||
          scenario.capabilityLevels.includes('runtime-tia')),
    ).map(({ id }) => ({
      evidence: {
        assertions: 1,
        fixture: `fixtures/${id}`,
      },
      id,
      passed: true,
    })),
    selectionGranularity: 'test-case',
    sourceRevision: '0123456789abcdef',
  }
}

const root = process.cwd()
const ajv = new Ajv2020({ allErrors: false, strict: false })
const validateSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      join(
        root,
        'docs/protocol/schemas/tiacore-adapter-certification-v1.schema.json',
      ),
      'utf8',
    ),
  ),
)

function rejects(value: unknown): boolean {
  try {
    parseAdapterCertificationReceipt(value)
    return false
  } catch {
    return true
  }
}

describe('adapter conformance certification', () => {
  test('keeps the public scenario catalog synchronized with JSON', () => {
    const catalog = JSON.parse(
      readFileSync(
        join(root, 'docs/protocol/conformance/adapter/v1/scenarios.json'),
        'utf8',
      ),
    ) as {
      contractVersion: number
      scenarios: unknown[]
    }
    expect(catalog.contractVersion).toBe(1)
    expect(catalog.scenarios).toEqual(TIA_ADAPTER_CONFORMANCE_SCENARIOS)
    expect(Object.isFrozen(TIA_ADAPTER_CONFORMANCE_SCENARIOS)).toBe(true)
  })

  test('certifies a complete capability-scoped receipt', () => {
    expect(certifyAdapterReceipt(receipt())).toMatchObject({
      adapter: 'example-node',
      capabilityLevel: 'runtime-tia',
      passedScenarios: 12,
      runner: 'example@1.0.0',
      sourceRevision: '0123456789abcdef',
    })
  })

  test('requires feature-specific scenarios only when declared', () => {
    const value = receipt()
    value.features = ['parallelism']
    expect(() => certifyAdapterReceipt(value)).toThrow(
      /parallel-plan-deterministic/,
    )
    value.scenarios.push({
      evidence: { assertions: 2, fixture: 'fixtures/parallel' },
      id: 'parallel-plan-deterministic',
      passed: true,
    })
    expect(certifyAdapterReceipt(value).features).toEqual(['parallelism'])
  })

  test('rejects missing, failed, duplicate, and assertion-free evidence', () => {
    const missing = receipt()
    missing.scenarios.pop()
    expect(() => certifyAdapterReceipt(missing)).toThrow(/missing scenarios/)

    const failed = receipt()
    failed.scenarios[0]!.passed = false
    expect(() => certifyAdapterReceipt(failed)).toThrow(/failed scenarios/)

    const duplicate = receipt()
    duplicate.scenarios.push(structuredClone(duplicate.scenarios[0]!))
    expect(() => parseAdapterCertificationReceipt(duplicate)).toThrow(
      /duplicate values/,
    )

    const assertionFree = receipt()
    assertionFree.scenarios[0]!.evidence.assertions = 0
    expect(() => certifyAdapterReceipt(assertionFree)).toThrow(
      /has no assertions/,
    )
  })

  test('ignores scenarios the level and features do not require', () => {
    const value = receipt()
    value.capabilityLevel = 'static-impact'
    value.selectionGranularity = 'profile'
    const extra = value.scenarios.find(
      (scenario) => scenario.id === 'previous-failure-rerun',
    )!
    extra.passed = false
    extra.evidence.assertions = 0
    expect(certifyAdapterReceipt(value).passedScenarios).toBe(9)
  })

  test('normalizes order and keeps strings untrimmed', () => {
    const value = receipt()
    value.scenarios.reverse()
    value.features = ['worktrees', 'cached-outcomes']
    value.scenarios.push(
      {
        evidence: { assertions: 1, fixture: 'f' },
        id: 'worktree-ancestry-safe',
        passed: true,
      },
      {
        evidence: { assertions: 1, fixture: 'f' },
        id: 'cached-outcomes-replayed',
        passed: true,
      },
    )
    value.adapter = ' padded '
    const parsed = parseAdapterCertificationReceipt(value)
    expect(parsed.features).toEqual(['cached-outcomes', 'worktrees'])
    const ids = parsed.scenarios.map(({ id }) => id)
    expect(ids).toEqual([...ids].sort())
    expect(parsed.adapter).toBe(' padded ')
  })

  test.each([
    ['unknown receipt field', (v: Record<string, unknown>) => (v['extra'] = 1)],
    [
      'non-array scenarios',
      (v: Record<string, unknown>) => (v['scenarios'] = {}),
    ],
    ['blank adapter', (v: Record<string, unknown>) => (v['adapter'] = '  ')],
    [
      'oversized adapter',
      (v: Record<string, unknown>) => (v['adapter'] = 'a'.repeat(8_193)),
    ],
    [
      'contract version 2',
      (v: Record<string, unknown>) => (v['contractVersion'] = 2),
    ],
    [
      'protocol version 2',
      (v: Record<string, unknown>) => (v['protocolVersion'] = 2),
    ],
    [
      'unknown level',
      (v: Record<string, unknown>) => (v['capabilityLevel'] = 'x'),
    ],
    [
      'unknown feature',
      (v: Record<string, unknown>) => (v['features'] = ['x']),
    ],
    [
      'duplicate feature',
      (v: Record<string, unknown>) =>
        (v['features'] = ['worktrees', 'worktrees']),
    ],
    [
      'unparsable timestamp',
      (v: Record<string, unknown>) => (v['generatedAt'] = 'soon'),
    ],
    [
      'runtime level with file granularity',
      (v: Record<string, unknown>) => (v['selectionGranularity'] = 'test-file'),
    ],
    [
      'observed-file level with case granularity',
      (v: Record<string, unknown>) =>
        (v['capabilityLevel'] = 'observed-file-tia'),
    ],
    [
      'unknown environment field',
      (v: Record<string, unknown>) =>
        (v['environment'] = { architecture: 'x', operatingSystem: 'y', z: 1 }),
    ],
    [
      'too many scenarios',
      (v: Record<string, unknown>) =>
        (v['scenarios'] = Array.from({ length: 19 }, () => ({}))),
    ],
  ])('rejects %s', (_name, mutate) => {
    const value: Record<string, unknown> = { ...receipt() }
    mutate(value)
    expect(rejects(value)).toBe(true)
  })

  test('rejects malformed scenario results', () => {
    for (const mutate of [
      (s: Record<string, unknown>) => (s['id'] = 'not-a-scenario'),
      (s: Record<string, unknown>) => (s['passed'] = 'yes'),
      (s: Record<string, unknown>) => (s['extra'] = true),
      (s: Record<string, unknown>) =>
        (s['evidence'] = { assertions: -1, fixture: 'f' }),
      (s: Record<string, unknown>) => (s['evidence'] = { assertions: 1 }),
      (s: Record<string, unknown>) =>
        (s['evidence'] = { assertions: 1, fixture: 'f', extra: 1 }),
    ]) {
      const value = structuredClone(receipt())
      const scenario: Record<string, unknown> = { ...value.scenarios[0] }
      mutate(scenario)
      expect(rejects({ ...value, scenarios: [scenario] })).toBe(true)
    }
  })

  // The committed JSON Schema is looser than the parser (no level pairing, no
  // unique scenario ids, any scenario id, any text for generatedAt). The
  // decoder must accept a subset of what the schema accepts, never more.
  test('accepts only receipts the committed JSON Schema accepts', () => {
    expect(validateSchema(receipt())).toBe(true)
    const stricter: unknown[] = [
      { ...receipt(), selectionGranularity: 'test-file' },
      { ...receipt(), generatedAt: 'soon' },
      {
        ...receipt(),
        scenarios: [receipt().scenarios[0], receipt().scenarios[0]],
      },
      {
        ...receipt(),
        scenarios: [{ ...receipt().scenarios[0], id: 'not-a-scenario' }],
      },
    ]
    for (const value of stricter) {
      expect(validateSchema(value)).toBe(true)
      expect(rejects(value)).toBe(true)
    }
    const looserParser: unknown[] = [
      { ...receipt(), adapter: '' },
      { ...receipt(), extra: 1 },
      { ...receipt(), protocolVersion: 2 },
    ]
    for (const value of looserParser) {
      expect(validateSchema(value)).toBe(false)
      expect(rejects(value)).toBe(true)
    }
  })

  test('agrees with the 1.x parser on accept and reject', async () => {
    const old = await legacy<{
      parseAdapterCertificationReceipt(value: unknown): unknown
    }>('conformance/certification.js')
    const failing = structuredClone(receipt())
    failing.scenarios[0]!.evidence.assertions = Number.NaN
    const samples: unknown[] = [
      receipt(),
      { ...receipt(), extra: 1 },
      { ...receipt(), features: ['worktrees', 'worktrees'] },
      { ...receipt(), selectionGranularity: 'flow' },
      { ...receipt(), generatedAt: 'not a date' },
      { ...receipt(), sourceRevision: ' ' },
      failing,
      null,
      [],
    ]
    for (const sample of samples) {
      let accepted = true
      try {
        old.parseAdapterCertificationReceipt(sample)
      } catch {
        accepted = false
      }
      expect(!rejects(sample)).toBe(accepted)
    }
    expect(parseAdapterCertificationReceipt(receipt())).toEqual(
      old.parseAdapterCertificationReceipt(receipt()),
    )
  })
})

const write = (bytes: number) => `process.stdout.write("x".repeat(${bytes}))`

const scenarios = TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
  (scenario) =>
    scenario.capabilityLevels === undefined && scenario.feature === undefined,
)

function options(
  overrides: Partial<{
    arguments: string[]
    command: string
    cwd: string
    environment: Record<string, string>
    timeoutMs: number
  }> = {},
) {
  return {
    adapter: 'fixture-static',
    capabilityLevel: 'static-impact' as const,
    root: root,
    runner: { name: 'node', version: process.versions.node },
    scenarios: [
      {
        arguments: ['-e', 'process.exit(0)'],
        command: process.execPath,
        fixture: 'test/fixtures/x',
        id: 'baseline-full',
        ...overrides,
      },
    ],
    selectionGranularity: 'test-file' as const,
    sourceRevision: 'sha256:fixture',
  }
}

describe('executable adapter certification', () => {
  test('ties every claimed scenario to a bounded real process execution', async () => {
    const result = await executeAdapterCertification({
      ...options(),
      scenarios: scenarios.map(({ id }) => ({
        arguments: ['-e', 'process.exit(0)'],
        command: process.execPath,
        fixture: `test/fixtures/${id}`,
        id,
      })),
    })
    expect(certifyAdapterReceipt(result)).toMatchObject({
      adapter: 'fixture-static',
      passedScenarios: 9,
    })
    expect(
      result.scenarios.every(
        (scenario) =>
          (scenario.evidence.durationMs ?? 0) >= 0 &&
          Boolean(scenario.evidence.command),
      ),
    ).toBe(true)
  })

  test('records exit status, environment and working directory', async () => {
    const code = [
      'if (process.env.TIA_PROBE !== "yes") process.exit(3)',
      'if (!process.cwd().endsWith("conformance")) process.exit(4)',
    ].join(';')
    const passing = await executeAdapterCertification(
      options({
        arguments: ['-e', code],
        cwd: 'docs/protocol/conformance',
        environment: { TIA_PROBE: 'yes' },
      }),
    )
    expect(passing.scenarios[0]).toMatchObject({
      id: 'baseline-full',
      passed: true,
    })
    const failing = await executeAdapterCertification(
      options({ arguments: ['-e', 'process.exit(2)'] }),
    )
    expect(failing.scenarios[0]?.passed).toBe(false)
    const signalled = await executeAdapterCertification(
      options({ arguments: ['-e', 'process.kill(process.pid, "SIGKILL")'] }),
    )
    expect(signalled.scenarios[0]?.passed).toBe(false)
  })

  test('fails a scenario that exceeds its timeout and kills its process group', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tiacore-group-'))
    const pidFile = join(directory, 'pid')
    const code = [
      'const { spawn } = require("child_process")',
      `const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })`,
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    try {
      const started = performance.now()
      const result = await executeAdapterCertification(
        options({ arguments: ['-e', code], timeoutMs: 1_000 }),
      )
      expect(result.scenarios[0]?.passed).toBe(false)
      expect(performance.now() - started).toBeLessThan(10_000)
      const grandchild = Number(readFileSync(pidFile, 'utf8'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('fails a scenario whose output exceeds 1 MiB but not one of exactly 1 MiB', async () => {
    const exact = await executeAdapterCertification(
      options({ arguments: ['-e', write(1024 * 1024)] }),
    )
    expect(exact.scenarios[0]?.passed).toBe(true)
    const over = await executeAdapterCertification(
      options({ arguments: ['-e', write(1024 * 1024 + 1)] }),
    )
    expect(over.scenarios[0]?.passed).toBe(false)
  })

  test.each([0, 600_001, 1.5])('rejects timeout %s', async (timeoutMs) => {
    await expect(
      executeAdapterCertification(options({ timeoutMs })),
    ).rejects.toThrow(
      'invalid timeout for certification scenario baseline-full',
    )
  })

  test('rejects the whole run when a command cannot start', async () => {
    await expect(
      executeAdapterCertification(
        options({ command: 'tiacore-no-such-command' }),
      ),
    ).rejects.toThrow(/ENOENT/)
    await expect(
      executeAdapterCertification(options({ cwd: 'no/such/directory' })),
    ).rejects.toThrow(/ENOENT|no such|invalid/i)
  })
})
