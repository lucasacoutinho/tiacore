import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function tiacore(args: readonly string[]) {
  return spawnSync(process.execPath, ['dist/entries/cli.js', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

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
})
