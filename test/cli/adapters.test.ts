import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const legacyCli = fileURLToPath(
  new URL('../../.legacy/dist/entries/cli.js', import.meta.url),
)
const cli = fileURLToPath(new URL('../../dist/entries/cli.js', import.meta.url))

let directory = ''
let changes = ''
let objectChanges = ''
let k6Graph = ''
let maestroGraph = ''
let graphOptions = ''

function run(binary: string, args: readonly string[]) {
  return spawnSync(process.execPath, [binary, ...args], {
    cwd: directory,
    encoding: 'utf8',
  })
}

/** Runs both CLIs and expects the same status and the same stdout. */
function same(args: readonly string[]) {
  const mine = run(cli, args)
  const theirs = run(legacyCli, args)
  expect({ status: mine.status, stdout: mine.stdout }).toEqual({
    status: theirs.status,
    stdout: theirs.stdout,
  })
  if (theirs.status !== 0) {
    const message = theirs.stderr.split('\n').find((line) => line.trim() !== '')
    expect(mine.stderr).toContain(message?.replace(/^error: /u, '') ?? '')
  }
  return mine
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'tiacore-adapter-cli-'))
  changes = join(directory, 'changes.json')
  objectChanges = join(directory, 'changes-object.json')
  k6Graph = join(directory, 'k6-graph.json')
  maestroGraph = join(directory, 'maestro-graph.json')
  graphOptions = join(directory, 'graph-options.json')
  writeFileSync(changes, JSON.stringify(['k6/shared/http.js']))
  writeFileSync(
    objectChanges,
    JSON.stringify({ files: ['e2e/login.yaml'], provider: 'x' }),
  )
  writeFileSync(
    graphOptions,
    JSON.stringify({
      ignored: true,
      knownSources: ['docs/readme.md'],
      invalidators: [{ pattern: '**/*.lock', reason: 'lock changed' }],
    }),
  )
  const record = same([
    'k6',
    'record',
    '--root',
    join(fixtures, 'k6-project'),
    '--profiles',
    'k6/profiles',
    '--project',
    'fixture',
    '--environment-fingerprint',
    'env',
  ])
  writeFileSync(k6Graph, record.stdout)
  const maestro = same([
    'maestro',
    'record',
    '--root',
    join(fixtures, 'maestro-project'),
    '--flows',
    'e2e',
    '--project',
    'fixture',
    '--environment-fingerprint',
    'env',
  ])
  writeFileSync(maestroGraph, maestro.stdout)
})

afterAll(() => {
  rmSync(directory, { force: true, recursive: true })
})

const k6 = [
  '--root',
  join(fixtures, 'k6-project'),
  '--profiles',
  'k6/profiles',
  '--project',
  'fixture',
]
const maestro = [
  '--root',
  join(fixtures, 'maestro-project'),
  '--flows',
  'e2e',
  '--project',
  'fixture',
]
const gradle = ['--root', join(fixtures, 'gradle-project'), '--project', 'app']

describe('k6 commands', () => {
  test('discover', () => {
    expect(JSON.parse(same(['k6', 'discover', ...k6]).stdout)).toHaveLength(2)
  })

  test('record with graph options and a fingerprint', () => {
    const result = same([
      'k6',
      'record',
      ...k6,
      '--environment-fingerprint',
      'env',
      '--fingerprint',
      'fp',
      '--graph-options',
      graphOptions,
    ])
    expect(JSON.parse(result.stdout)).toMatchObject({
      fingerprint: 'fp',
      invalidators: [{ pattern: '**/*.lock' }],
      knownSources: ['docs/readme.md'],
    })
  })

  test.each([
    [[]],
    [['--force-full']],
    [['--ignore-unknown']],
    [['--ignore-change', 'k6/shared/**']],
    [['--allowed-profile', 'smoke']],
    [['--allowed-profile', 'nope']],
    [['--fingerprint', 'other']],
  ])('plan with %j', (extra) => {
    expect(
      same([
        'k6',
        'plan',
        ...k6,
        '--changes',
        changes,
        '--environment-fingerprint',
        'env',
        '--graph',
        k6Graph,
        ...extra,
      ]).status,
    ).toBe(extra.includes('nope') ? 1 : 0)
  })

  test('plan without a graph is a full plan and accepts an object change set', () => {
    const result = same([
      'k6',
      'plan',
      ...k6,
      '--changes',
      objectChanges,
      '--environment-fingerprint',
      'env',
    ])
    expect(JSON.parse(result.stdout).mode).toBe('full')
  })

  test('writes to a file with --output and to stdout with -', () => {
    const file = join(directory, 'out.json')
    const toFile = run(cli, ['k6', 'discover', ...k6, '--output', file])
    expect(toFile).toMatchObject({ status: 0, stdout: '' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2)
    expect(run(cli, ['k6', 'discover', ...k6, '--output', '-']).stdout).toBe(
      `${readFileSync(file, 'utf8')}`,
    )
  })

  test.each([
    [['k6', 'discover']],
    [['k6']],
    [['k6', 'run']],
    [['k6', 'discover', ...k6, '--graph-options', join(tmpdir(), 'missing')]],
  ])('fails %j with exit 1', (args) => {
    expect(run(cli, args).status).toBe(1)
    expect(run(legacyCli, args).status).toBe(1)
  })

  test('help lists the subcommands and exits 0', () => {
    const help = run(cli, ['k6', '--help'])
    expect(help.status).toBe(0)
    for (const name of ['discover', 'record', 'plan']) {
      expect(help.stdout).toContain(name)
    }
    expect(help.stdout).not.toContain('execute')
  })
})

describe('gradle commands', () => {
  test('discover with and without globs', () => {
    expect(
      JSON.parse(same(['gradle', 'discover', ...gradle]).stdout),
    ).toHaveLength(2)
    expect(
      same([
        'gradle',
        'discover',
        ...gradle,
        '--test',
        'src/test/java/**/*.java',
      ]).status,
    ).toBe(0)
  })

  test('--source is accepted and has no effect', () => {
    const without = run(cli, ['gradle', 'discover', ...gradle])
    const withSource = run(cli, [
      'gradle',
      'discover',
      ...gradle,
      '--source',
      'nothing/**',
    ])
    expect(withSource).toMatchObject({ status: 0, stdout: without.stdout })
  })

  test.each([
    [[]],
    [['--force-full']],
    [['--ignore-unknown']],
    [['--ignore-change', 'src/**']],
    [['--fingerprint', '']],
    [['--graph', '']],
  ])('plan with %j', (extra) => {
    expect(
      same([
        'gradle',
        'plan',
        ...gradle,
        '--changes',
        changes,
        '--environment-fingerprint',
        'env',
        ...extra,
      ]).status,
    ).toBe(0)
  })

  test('has no record command', () => {
    expect(run(cli, ['gradle', 'record', ...gradle]).status).toBe(1)
    expect(run(cli, ['gradle', '--help']).stdout).not.toContain('record')
  })
})

describe('maestro commands', () => {
  test('discover with tag filters', () => {
    expect(same(['maestro', 'discover', ...maestro]).status).toBe(0)
    expect(
      same(['maestro', 'discover', ...maestro, '--exclude-tag', 'experimental'])
        .status,
    ).toBe(0)
    expect(
      same(['maestro', 'discover', ...maestro, '--include-tag', 'settings'])
        .status,
    ).toBe(0)
  })

  test('record with graph options', () => {
    expect(
      same([
        'maestro',
        'record',
        ...maestro,
        '--environment-fingerprint',
        'env',
        '--fingerprint',
        'fp',
        '--graph-options',
        graphOptions,
      ]).status,
    ).toBe(0)
  })

  test.each([
    [[]],
    [['--force-full']],
    [['--ignore-unknown']],
    [['--ignore-change', 'e2e/**']],
    [['--exclude-tag', 'experimental']],
  ])('plan with %j', (extra) => {
    const result = same([
      'maestro',
      'plan',
      ...maestro,
      '--changes',
      objectChanges,
      '--environment-fingerprint',
      'env',
      '--graph',
      maestroGraph,
      ...extra,
    ])
    expect(JSON.parse(result.stdout)).toHaveProperty('selected')
  })

  test('an invalid graph aborts before planning', () => {
    const bad = join(directory, 'bad-graph.json')
    writeFileSync(bad, '{"protocolVersion":1}')
    const result = run(cli, [
      'maestro',
      'plan',
      ...maestro,
      '--changes',
      objectChanges,
      '--environment-fingerprint',
      'env',
      '--graph',
      bad,
    ])
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })
})
