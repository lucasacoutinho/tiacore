import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  TIA_ADAPTER_CONFORMANCE_SCENARIOS,
  type TiaAdapterCertificationReceipt,
} from '../../../src/entries/conformance.js'

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

describe('tiacore CLI', () => {
  test('runs through a package-manager style executable symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'tiacore-bin-'))
    temporaryDirectories.push(root)
    const binary = join(root, 'tiacore')
    symlinkSync(join(process.cwd(), 'dist/entries/cli.js'), binary)

    const help = execFileSync(binary, ['--help'], { encoding: 'utf8' })
    expect(help).toContain('plan [options]')
    expect(help).toContain('k6')
    expect(help).toContain('gradle')
    expect(help).not.toContain('k6:')

    const adapterHelp = execFileSync(binary, ['k6', '--help'], {
      encoding: 'utf8',
    })
    expect(adapterHelp).toContain('discover')
    expect(adapterHelp).toContain('record')
    expect(adapterHelp).toContain('plan')
  })

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
  })
})
