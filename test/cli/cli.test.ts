import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  TIA_ADAPTER_CONFORMANCE_SCENARIOS,
  type TiaAdapterCertificationReceipt,
} from '../../src/entries/conformance.ts'

const temporaryDirectories: string[] = []

function fixture(): {
  catalog: string
  changes: string
  graph: string
} {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-cli-'))
  temporaryDirectories.push(root)
  const catalog = join(root, 'catalog.json')
  const changes = join(root, 'changes.json')
  const graph = join(root, 'graph.json')
  const suites = [
    {
      adapter: 'k6',
      file: 'profiles/smoke.js',
      id: 'k6:smoke',
      project: 'load',
    },
  ]
  writeFileSync(catalog, JSON.stringify(suites))
  writeFileSync(changes, JSON.stringify(['src/health.ts']))
  writeFileSync(
    graph,
    JSON.stringify({
      complete: true,
      environmentFingerprint: 'local',
      fingerprint: 'project',
      observations: [
        {
          confidence: 'observed',
          kind: 'route',
          source: 'src/health.ts',
          suiteId: 'k6:smoke',
        },
      ],
      protocolVersion: 1,
      suites,
    }),
  )
  return { catalog, changes, graph }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function tiacore(args: readonly string[]) {
  return spawnSync(process.execPath, ['dist/entries/cli.js', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

const probeScenario = (id: string, code: string) => ({
  arguments: ['-e', code],
  command: process.execPath,
  fixture: `fixtures/${id}`,
  id,
})
const lane = (exit: number) =>
  `export default { lanes: [{ id: 'only', command: process.execPath, arguments: ['-e', 'process.exit(${exit})'] }] }`
const spec = (exit: number) => ({
  adapter: 'example-static',
  capabilityLevel: 'static-impact',
  runner: { name: 'node', version: process.versions.node },
  scenarios: TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
    (item) => item.feature === undefined && item.capabilityLevels === undefined,
  ).map(({ id }) =>
    probeScenario(id, id === 'baseline-full' ? `process.exit(${exit})` : '0'),
  ),
  selectionGranularity: 'profile',
  sourceRevision: 'sha256:fixture',
})
describe('tiacore CLI', () => {
  test('plans from portable JSON files', () => {
    const files = fixture()
    const output = execFileSync(
      process.execPath,
      [
        'dist/entries/cli.js',
        'plan',
        '--catalog',
        files.catalog,
        '--changes',
        files.changes,
        '--graph',
        files.graph,
        '--fingerprint',
        'project',
        '--environment-fingerprint',
        'local',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    )

    expect(JSON.parse(output)).toMatchObject({
      mode: 'selective',
      selected: ['k6:smoke'],
    })
  })

  test('validates and inspects a graph', () => {
    const files = fixture()
    const output = execFileSync(
      process.execPath,
      ['dist/entries/cli.js', 'doctor', '--graph', files.graph],
      { cwd: process.cwd(), encoding: 'utf8' },
    )

    expect(JSON.parse(output)).toEqual({
      ok: true,
      protocolVersion: 1,
      suites: 1,
    })
  })

  test('summarizes a graph with inspect and merges partitions', () => {
    const files = fixture()
    expect(
      JSON.parse(tiacore(['inspect', '--graph', files.graph]).stdout),
    ).toEqual({
      adapters: ['k6'],
      complete: true,
      environmentFingerprint: 'local',
      fingerprint: 'project',
      observations: 1,
      protocolVersion: 1,
      suites: 1,
    })
    const output = join(temporaryDirectories.at(-1) ?? '', 'merged.json')
    const merged = tiacore([
      'merge',
      '--graph',
      files.graph,
      '--graph',
      files.graph,
      '--output',
      output,
    ])
    expect(merged.status).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      complete: true,
      suites: [{ id: 'k6:smoke' }],
    })
  })

  test.each([
    [[], 1],
    [['--help'], 0],
    [['plan', '--help'], 0],
    [['nope'], 1],
    [['plan'], 1],
  ])('exits %j with %i', (args, code) => {
    expect(tiacore(args).status).toBe(code)
  })

  test('prints the version alone', () => {
    const manifest: { version: string } = JSON.parse(
      readFileSync('package.json', 'utf8'),
    )
    expect(tiacore(['--version']).stdout).toBe(`${manifest.version}\n`)
  })

  test('reports input errors on stderr with exit code 1', () => {
    const result = tiacore([
      'doctor',
      '--graph',
      join(tmpdir(), 'tiacore-missing-graph.json'),
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ENOENT')
    expect(result.stdout).toBe('')
  })
  test('certifies an adapter receipt through the packaged CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-certify-'))
    temporaryDirectories.push(root)
    const path = join(root, 'receipt.json')
    const receipt: TiaAdapterCertificationReceipt = {
      adapter: 'example-static',
      capabilityLevel: 'static-impact',
      contractVersion: 1,
      environment: {
        architecture: 'x64',
        operatingSystem: 'linux',
      },
      features: [],
      generatedAt: '2026-07-30T00:00:00.000Z',
      protocolVersion: 1,
      runner: { name: 'example', version: '1.0.0' },
      scenarios: TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
        (scenario) =>
          scenario.feature === undefined &&
          (scenario.capabilityLevels === undefined ||
            scenario.capabilityLevels.includes('static-impact')),
      ).map(({ id }) => ({
        evidence: { assertions: 1, fixture: `fixtures/${id}` },
        id,
        passed: true,
      })),
      selectionGranularity: 'profile',
      sourceRevision: '0123456789abcdef',
    }
    writeFileSync(path, JSON.stringify(receipt))

    const output = execFileSync(
      process.execPath,
      ['dist/entries/cli.js', 'certify', 'adapter', '--receipt', path],
      { cwd: process.cwd(), encoding: 'utf8' },
    )

    expect(JSON.parse(output)).toMatchObject({
      adapter: 'example-static',
      capabilityLevel: 'static-impact',
      passedScenarios: 9,
    })

    writeFileSync(path, JSON.stringify({ ...receipt, extra: true }))
    const rejected = tiacore(['certify', 'adapter', '--receipt', path])
    expect(rejected.status).toBe(1)
    expect(rejected.stdout).toBe('')
    expect(rejected.stderr).toContain('unknown field')
  })

  test('executes a certification spec, writing the receipt even when it fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-execute-'))
    temporaryDirectories.push(root)
    const specPath = join(root, 'spec.json')
    const receiptPath = join(root, 'receipt.json')

    writeFileSync(specPath, JSON.stringify(spec(0)))
    const passing = tiacore(['certify', 'execute', '--spec', specPath])
    expect(passing.status).toBe(0)
    expect(JSON.parse(passing.stdout).scenarios).toHaveLength(9)

    writeFileSync(specPath, JSON.stringify(spec(1)))
    const failing = tiacore([
      'certify',
      'execute',
      '--spec',
      specPath,
      '--output',
      receiptPath,
    ])
    expect(failing.status).toBe(1)
    expect(failing.stdout).toBe('')
    expect(
      JSON.parse(readFileSync(receiptPath, 'utf8')).scenarios[0],
    ).toMatchObject({ id: 'baseline-full', passed: false })

    writeFileSync(specPath, JSON.stringify({ adapter: 'x' }))
    expect(tiacore(['certify', 'execute', '--spec', specPath]).status).toBe(1)
  })

  test('runs workspace lanes and exits 1 when one fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-run-'))
    temporaryDirectories.push(root)
    const config = join(root, 'tiacore.config.mjs')
    const output = join(root, 'receipt.json')

    writeFileSync(config, lane(0))
    expect(
      tiacore(['run', '--config', config, '--output', output]).status,
    ).toBe(0)
    expect(JSON.parse(readFileSync(output, 'utf8')).success).toBe(true)

    writeFileSync(config, lane(1))
    expect(
      tiacore(['run', '--config', config, '--output', output]).status,
    ).toBe(1)
    expect(JSON.parse(readFileSync(output, 'utf8')).success).toBe(false)
  })

  test('lists certify and run in the root help and fails certify alone', () => {
    const help = tiacore(['--help']).stdout
    expect(help).toContain('certify')
    expect(help).toContain('run')
    expect(tiacore(['certify']).status).toBe(1)
    expect(tiacore(['certify', '--help']).stdout).toContain('execute')
  })
})
