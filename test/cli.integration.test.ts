import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

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
    symlinkSync(join(process.cwd(), 'dist/cli.js'), binary)

    expect(execFileSync(binary, ['--help'], { encoding: 'utf8' })).toContain(
      'tiacore plan',
    )
  })

  test('plans from portable JSON files', () => {
    const files = fixture()
    const output = execFileSync(
      process.execPath,
      [
        'dist/cli.js',
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
      ['dist/cli.js', 'doctor', '--graph', files.graph],
      { cwd: process.cwd(), encoding: 'utf8' },
    )

    expect(JSON.parse(output)).toEqual({
      ok: true,
      protocolVersion: 1,
      suites: 1,
    })
  })
})
