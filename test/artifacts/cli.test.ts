import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TiaArtifactPublishReceipt } from '../../src/core/artifacts.ts'
import { execute } from '../../src/cli/main.ts'
import { graph, privateKeyPem, temporaryRoot, writeStored } from './support.ts'

// `tiacore artifacts publish|promote`.

afterEach(() => {
  vi.unstubAllEnvs()
})

async function prepared(
  overrides: Parameters<typeof graph>[1] = {},
): Promise<{ receipt: string; root: string }> {
  const root = temporaryRoot('tiacore-cli-artifacts-')
  await writeStored(
    join(root, '.tia'),
    graph('cli-fingerprint', {
      baseline: { sha: 'cli-sha', source: 'git', workingTree: {} },
      ...overrides,
    }),
  )
  vi.stubEnv('TIA_ARTIFACT_PRIVATE_KEY', privateKeyPem)
  return { receipt: join(root, 'receipt.json'), root }
}

const required = [
  '--artifact-id',
  'build-1',
  '--run-id',
  'run-1',
  '--signing-key-id',
  'k1',
]

async function run(
  command: 'promote' | 'publish',
  root: string,
  receipt: string,
  extra: string[] = [],
) {
  const outcome = await execute([
    'artifacts',
    command,
    ...required,
    '--root',
    root,
    '--receipt',
    receipt,
    ...extra,
  ])
  return outcome
}

describe('artifacts publish and promote', () => {
  test('publish writes the receipt, the archive and the manifest under --root', async () => {
    const { receipt, root } = await prepared()
    const outcome = await run('publish', root, receipt, [
      '--parent',
      'p1',
      '--parent',
      'p2',
      '--producer',
      'cli-ci',
      '--group',
      'g1',
    ])
    expect(outcome).toEqual({ code: 0 })
    const written = JSON.parse(
      readFileSync(receipt, 'utf8'),
    ) as TiaArtifactPublishReceipt
    expect(written).toMatchObject({
      artifactId: 'build-1',
      baselineSha: 'cli-sha',
      fingerprint: 'cli-fingerprint',
      keyId: 'k1',
      manifestUrl: './manifest.json',
      promoted: false,
      sink: 'filesystem artifact sink',
    })
    const files = readdirSync(join(root, '.tia-artifacts')).sort()
    expect(files).toEqual([
      'manifest.json',
      `tiacore-${written.sha256.slice(0, 24)}.zip`,
    ])
    const manifest = JSON.parse(
      readFileSync(join(root, '.tia-artifacts/manifest.json'), 'utf8'),
    ) as {
      artifacts: Array<{
        group: string
        lineage: { parents: string[]; producer: string }
      }>
    }
    expect(manifest.artifacts[0]?.group).toBe('g1')
    expect(manifest.artifacts[0]?.lineage).toMatchObject({
      parents: ['p1', 'p2'],
      producer: 'cli-ci',
    })
    expect(Date.parse(written.trustExpiresAt) - Date.now()).toBeGreaterThan(
      6 * 86_400_000,
    )
  })

  test('honours --output-dir, --cache-dir, --base-url and --trust-expires-in', async () => {
    const { receipt, root } = await prepared()
    const outcome = await run('promote', root, receipt, [
      '--output-dir',
      'dist-artifacts',
      '--base-url',
      'https://cdn.example/tia',
      '--trust-expires-in',
      '3600',
      '--runner',
      'node',
      '--require-coverage',
    ])
    expect(outcome).toEqual({ code: 0 })
    const written = JSON.parse(
      readFileSync(receipt, 'utf8'),
    ) as TiaArtifactPublishReceipt
    expect(written.promoted).toBe(true)
    expect(written.artifactUrl).toMatch(
      /^https:\/\/cdn\.example\/tia\/tiacore-/u,
    )
    expect(Date.parse(written.trustExpiresAt) - Date.now()).toBeLessThan(
      3_700_000,
    )
    expect(readdirSync(join(root, 'dist-artifacts'))).toHaveLength(2)
  })

  test('accepts the signing key as base64 DER from a named variable', async () => {
    const { receipt, root } = await prepared()
    vi.stubEnv('MY_KEY', privateKeyPem.replace(/-----[A-Z ]+-----|\s/gu, ''))
    const outcome = await run('publish', root, receipt, [
      '--signing-key-env',
      'MY_KEY',
    ])
    expect(outcome).toEqual({ code: 0 })
  })

  test('a missing or blank signing key fails first, before any other validation', async () => {
    const { receipt, root } = await prepared()
    vi.stubEnv('TIA_ARTIFACT_PRIVATE_KEY', '   ')
    const outcome = await execute([
      'artifacts',
      'publish',
      '--artifact-id',
      ' ',
      '--run-id',
      ' ',
      '--signing-key-id',
      'bad id',
      '--root',
      root,
      '--receipt',
      receipt,
    ])
    expect(outcome).toEqual({
      code: 1,
      message:
        'TIA artifact signing key is missing from TIA_ARTIFACT_PRIVATE_KEY',
    })
    const named = await run('publish', root, receipt, [
      '--signing-key-env',
      'UNSET_KEY_VARIABLE',
    ])
    expect(named.message).toBe(
      'TIA artifact signing key is missing from UNSET_KEY_VARIABLE',
    )
  })

  test('validates in the documented order and with the documented messages', async () => {
    const { receipt, root } = await prepared()
    const failure = async (extra: string[], base = required) =>
      (
        await execute([
          'artifacts',
          'publish',
          ...base,
          '--root',
          root,
          '--receipt',
          receipt,
          ...extra,
        ])
      ).message
    expect(
      await failure(
        [],
        ['--artifact-id', ' ', '--run-id', 'r', '--signing-key-id', 'k'],
      ),
    ).toBe('TIA artifact id cannot be empty')
    expect(
      await failure(
        [],
        ['--artifact-id', 'a', '--run-id', ' ', '--signing-key-id', 'k'],
      ),
    ).toBe('TIA artifact run id cannot be empty')
    expect(await failure(['--runner', '../x'])).toBe(
      'TIA artifact runner must be a safe relative path',
    )
    for (const seconds of ['abc', '0', '-5', '1.5', '31536001']) {
      expect(await failure(['--trust-expires-in', seconds])).toBe(
        'TIA artifact signing expiry must be between 1 second and 1 year',
      )
    }
    expect(await failure(['--cache-dir', 'nothing-here'])).toBe(
      `no valid TIA graph exists in ${join(root, 'nothing-here')}`,
    )
    expect(
      await failure(
        [],
        ['--artifact-id', 'a', '--run-id', 'r', '--signing-key-id', 'bad id'],
      ),
    ).toBe('TIA artifact signing key id is invalid')
    vi.stubEnv('TIA_ARTIFACT_PRIVATE_KEY', 'not a key')
    expect(await failure([])).toBe(
      'TIA artifact signing key is not a valid private key',
    )
  })

  test('promote refuses partial graphs and --require-coverage only matters to promote', async () => {
    const partial = await prepared({
      complete: false,
      partition: { index: 1, total: 2 },
    })
    expect((await run('publish', partial.root, partial.receipt)).code).toBe(0)
    expect((await run('promote', partial.root, partial.receipt)).message).toBe(
      'TIA refuses to promote a partial graph',
    )
    const uncovered = await prepared({ coverageComplete: false })
    expect(
      (
        await run('publish', uncovered.root, uncovered.receipt, [
          '--require-coverage',
        ])
      ).code,
    ).toBe(0)
    expect(
      (
        await run('promote', uncovered.root, uncovered.receipt, [
          '--require-coverage',
        ])
      ).message,
    ).toBe('TIA refuses to promote a graph without complete coverage')
  })

  test('requires the identifying flags', async () => {
    const outcome = await execute(['artifacts', 'publish'])
    expect(outcome.code).toBe(1)
    expect(outcome.message).toBeDefined()
  })

  test('is listed between certify and run, and needs a subcommand', async () => {
    const outcome = await execute(['artifacts'])
    expect(outcome.code).toBe(1)
  })

  test('the private key never reaches an error message', async () => {
    const { receipt, root } = await prepared()
    vi.stubEnv('TIA_ARTIFACT_PRIVATE_KEY', 'confidential-material')
    const outcome = await run('publish', root, receipt)
    expect(outcome.message).toBe(
      'TIA artifact signing key is not a valid private key',
    )
    expect(JSON.stringify(outcome)).not.toContain('confidential')
  })
})
