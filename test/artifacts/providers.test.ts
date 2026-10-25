import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TiaArtifactCandidate } from '../../src/core/artifacts.ts'
import { artifactProviders } from '../../src/engine/artifacts/restore.ts'
import { createFilesystemArtifactProvider } from '../../src/engine/artifacts/filesystem.ts'
import { createGitHubActionsArtifactProvider } from '../../src/engine/artifacts/github-actions.ts'
import { createGitLabCiArtifactProvider } from '../../src/engine/artifacts/gitlab-ci.ts'
import { createHttpManifestArtifactProvider } from '../../src/engine/artifacts/http-manifest.ts'
import {
  archive,
  cacheDirectory,
  graph,
  readStored,
  restore,
  sha256,
  temporaryRoot,
  writeStored,
} from './support.ts'

// Port of 1.x test/unit/artifacts/provider-artifacts.test.ts plus the ART-HTTP,
// ART-GL, ART-GH and ART-FS rows 1.x left untested.

const servers: Server[] = []
const unsigned = { allowUnsigned: true }

type Handler = (request: IncomingMessage, response: ServerResponse) => void

async function localServer(handle: Handler): Promise<string> {
  const server = createServer(handle)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('artifact fixture server did not bind')
  }
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  )
})

const loadFrom = (
  provider: { load: (context: never) => unknown },
  context: { fingerprint: string; runner?: string; root?: string },
) =>
  (
    provider as {
      load: (context: unknown) => Promise<TiaArtifactCandidate[] | null>
    }
  ).load(context)

const entry = (extra: object = {}) => ({ id: 'a', url: '/a.zip', ...extra })

describe('HTTP manifest provider', () => {
  test('restores from an authenticated HTTP manifest and archive', async () => {
    vi.stubEnv('TIACORE_MANIFEST_TOKEN', 'manifest-secret')
    const zipped = archive('http-current')
    const requests: Array<{ authorization?: string; path: string }> = []
    const baseUrl = await localServer((request, response) => {
      requests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        path: request.url ?? '',
      })
      if (request.url === '/manifest.json') {
        response.end(
          JSON.stringify({
            artifacts: [
              {
                fingerprint: 'http-current',
                group: 'pipeline-42',
                id: 'artifact-42',
                url: '/artifact.zip',
              },
            ],
            version: 1,
          }),
        )
        return
      }
      if (request.url === '/artifact.zip') {
        response.end(Buffer.from(zipped))
        return
      }
      response.writeHead(404).end()
    })
    const cacheDir = cacheDirectory()

    const result = await restore({
      cacheDir,
      fingerprint: 'http-current',
      log: false,
      providers: artifactProviders({
        provider: 'http-manifest',
        tokenEnv: 'TIACORE_MANIFEST_TOKEN',
        url: `${baseUrl}/manifest.json`,
      }),
      trust: unsigned,
    })

    expect(result).toMatchObject({
      artifactId: 'artifact-42',
      provider: 'HTTP artifact manifest',
      restored: true,
    })
    expect((await readStored(cacheDir))?.fingerprint).toBe('http-current')
    expect(requests).toEqual([
      { authorization: 'Bearer manifest-secret', path: '/manifest.json' },
      { authorization: 'Bearer manifest-secret', path: '/artifact.zip' },
    ])
  })

  test('requires promoted artifacts and verifies archive integrity', async () => {
    const zipped = archive('integrity-current')
    const digest = sha256(zipped)
    const requests: string[] = []
    const baseUrl = await localServer((request, response) => {
      requests.push(request.url ?? '')
      if (request.url === '/manifest.json') {
        response.end(
          JSON.stringify({
            artifacts: [
              {
                fingerprint: 'integrity-current',
                id: 'unpromoted',
                promoted: false,
                sha256: digest,
                size: zipped.byteLength,
                url: '/unpromoted.zip',
              },
              {
                fingerprint: 'integrity-current',
                id: 'corrupt',
                promoted: true,
                sha256: '0'.repeat(64),
                size: zipped.byteLength,
                url: '/corrupt.zip',
              },
              {
                fingerprint: 'integrity-current',
                id: 'short',
                promoted: true,
                size: zipped.byteLength + 1,
                url: '/corrupt.zip',
              },
            ],
            version: 1,
          }),
        )
        return
      }
      if (request.url === '/corrupt.zip') {
        response.end(Buffer.from(zipped))
        return
      }
      response.writeHead(404).end()
    })

    const result = await restore({
      cacheDir: cacheDirectory(),
      fingerprint: 'integrity-current',
      log: false,
      providers: artifactProviders({
        promotedOnly: true,
        provider: 'http-manifest',
        url: `${baseUrl}/manifest.json`,
      }),
      trust: unsigned,
    })

    expect(result).toEqual({
      reason: 'no provider returned a compatible artifact',
      restored: false,
    })
    expect(requests).toEqual(['/manifest.json', '/corrupt.zip', '/corrupt.zip'])
  })

  test('sends the manifest credential only to the manifest origin', async () => {
    vi.stubEnv('TIACORE_MANIFEST_TOKEN', 'manifest-secret')
    const zipped = archive('origin')
    const seen: Array<{ origin: string; authorization: string | undefined }> =
      []
    const storage = await localServer((request, response) => {
      seen.push({
        authorization: request.headers.authorization,
        origin: 'storage',
      })
      response.end(Buffer.from(zipped))
    })
    const manifestHost = await localServer((request, response) => {
      seen.push({
        authorization: request.headers.authorization,
        origin: 'manifest',
      })
      if (request.url === '/local.zip') {
        response.end(Buffer.from(zipped))
        return
      }
      response.end(
        JSON.stringify({
          artifacts: [
            { id: 1, url: `${storage}/signed.zip` },
            { id: 2, url: '/local.zip' },
          ],
          version: 1,
        }),
      )
    })
    const provider = createHttpManifestArtifactProvider({
      tokenEnv: 'TIACORE_MANIFEST_TOKEN',
      url: `${manifestHost}/manifest.json`,
    })
    const candidates = await loadFrom(provider, { fingerprint: 'origin' })
    expect(candidates?.map((candidate) => candidate.id)).toEqual([1, 2])
    expect(seen).toEqual([
      { authorization: 'Bearer manifest-secret', origin: 'manifest' },
      { authorization: undefined, origin: 'storage' },
      { authorization: 'Bearer manifest-secret', origin: 'manifest' },
    ])
  })

  test('uses the configured scheme and sends nothing without a token', async () => {
    vi.stubEnv('TIACORE_MANIFEST_TOKEN', 'abc')
    const authorizations: Array<string | undefined> = []
    const baseUrl = await localServer((request, response) => {
      authorizations.push(request.headers.authorization)
      response.end(JSON.stringify({ artifacts: [], version: 1 }))
    })
    const url = `${baseUrl}/m.json`
    await loadFrom(
      createHttpManifestArtifactProvider({
        authorizationScheme: 'Token',
        tokenEnv: 'TIACORE_MANIFEST_TOKEN',
        url,
      }),
      { fingerprint: 'x' },
    )
    await loadFrom(
      createHttpManifestArtifactProvider({ tokenEnv: 'TIACORE_UNSET', url }),
      { fingerprint: 'x' },
    )
    await loadFrom(createHttpManifestArtifactProvider({ url }), {
      fingerprint: 'x',
    })
    expect(authorizations).toEqual(['Token abc', undefined, undefined])
  })

  test('refuses other protocols, invalid URLs and failing manifests', async () => {
    const never = vi.fn<typeof fetch>()
    for (const url of [
      'ftp://example.test/m.json',
      'file:///etc/passwd',
      'nope',
    ]) {
      await expect(
        loadFrom(createHttpManifestArtifactProvider({ url }, never), {
          fingerprint: 'x',
        }),
      ).resolves.toBeNull()
    }
    expect(never).not.toHaveBeenCalled()
    const failing = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('no', { status: 500 }))
    await expect(
      loadFrom(
        createHttpManifestArtifactProvider(
          { url: 'https://a.test/m' },
          failing,
        ),
        { fingerprint: 'x' },
      ),
    ).resolves.toBeNull()
  })

  test('rejects an oversized, non-JSON or schema-invalid manifest as a whole', async () => {
    const bodies = [
      'x'.repeat(1024 * 1024 + 1),
      'not json',
      JSON.stringify({ artifacts: [], version: 2 }),
      JSON.stringify({ artifacts: {}, version: 1 }),
      JSON.stringify({ artifacts: [entry({ extra: 1 })], version: 1 }),
      JSON.stringify({
        artifacts: [entry({ url: 'u'.repeat(8193) })],
        version: 1,
      }),
      JSON.stringify({ artifacts: [entry({ sha256: 'ABC' })], version: 1 }),
      JSON.stringify({ artifacts: [entry({ size: -1 })], version: 1 }),
      JSON.stringify({ artifacts: [entry({ id: 1.5 })], version: 1 }),
      JSON.stringify({
        artifacts: [entry(), { id: [], url: 'b' }],
        version: 1,
      }),
      JSON.stringify({ artifacts: [], extra: 1, version: 1 }),
      JSON.stringify({
        artifacts: Array.from({ length: 101 }, (_, index) =>
          entry({ id: index }),
        ),
        version: 1,
      }),
    ]
    for (const body of bodies) {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(body))
      await expect(
        loadFrom(
          createHttpManifestArtifactProvider(
            { url: 'https://a.test/m' },
            request,
          ),
          { fingerprint: 'x' },
        ),
      ).resolves.toBeNull()
      expect(request).toHaveBeenCalledTimes(1)
    }
  })

  test('filters by fingerprint and runner, then keeps the first maxArtifacts', async () => {
    const zipped = archive('wanted')
    const downloads: string[] = []
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/m.json')) {
        return new Response(
          JSON.stringify({
            artifacts: [
              { fingerprint: 'other', id: 'a', url: 'a.zip' },
              { id: 'b', runner: 'bun', url: 'b.zip' },
              { id: 'c', url: 'c.zip' },
              { fingerprint: 'wanted', id: 'd', url: 'd.zip' },
              { id: 'e', url: 'e.zip' },
              { id: 'f', url: 'ftp://nowhere/f.zip' },
            ],
            version: 1,
          }),
        )
      }
      downloads.push(url)
      return new Response(zipped)
    })
    const candidates = await loadFrom(
      createHttpManifestArtifactProvider(
        { maxArtifacts: 2, url: 'https://a.test/dir/m.json' },
        request,
      ),
      { fingerprint: 'wanted', runner: 'node' },
    )
    expect(downloads).toEqual([
      'https://a.test/dir/c.zip',
      'https://a.test/dir/d.zip',
    ])
    expect(candidates).toBeNull()
  })
})

describe('GitLab CI provider', () => {
  test('discovers a successful prior GitLab pipeline job', async () => {
    vi.stubEnv('TIACORE_GITLAB_TOKEN', 'gitlab-secret')
    vi.stubEnv('CI_PIPELINE_ID', '101')
    const zipped = archive('gitlab-current')
    const requests: string[] = []
    const baseUrl = await localServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      expect(request.headers['private-token']).toBe('gitlab-secret')
      if (request.url?.startsWith('/api/v4/projects/42/pipelines?')) {
        response.end(
          JSON.stringify([
            { id: 101, ref: 'main', status: 'success' },
            { id: 100, ref: 'main', status: 'success' },
          ]),
        )
        return
      }
      if (
        request.url ===
        '/api/v4/projects/42/pipelines/100/jobs?scope%5B%5D=success&per_page=100'
      ) {
        response.end(
          JSON.stringify([
            {
              artifacts_file: {
                filename: 'tiacore.zip',
                size: zipped.byteLength,
              },
              id: 900,
              name: 'tiacore-baseline',
              status: 'success',
            },
          ]),
        )
        return
      }
      if (request.url === '/api/v4/projects/42/jobs/900/artifacts') {
        response.end(Buffer.from(zipped))
        return
      }
      response.writeHead(404).end()
    })
    const cacheDir = cacheDirectory()

    const result = await restore({
      cacheDir,
      fingerprint: 'gitlab-current',
      log: false,
      providers: artifactProviders({
        apiUrl: `${baseUrl}/api/v4`,
        branch: 'main',
        jobName: 'tiacore-*',
        projectId: 42,
        provider: 'gitlab-ci',
        tokenEnv: 'TIACORE_GITLAB_TOKEN',
        tokenHeader: 'PRIVATE-TOKEN',
      }),
      trust: unsigned,
    })

    expect(result).toMatchObject({
      artifactId: 900,
      provider: 'GitLab CI',
      restored: true,
    })
    expect((await readStored(cacheDir))?.fingerprint).toBe('gitlab-current')
    expect(requests).toHaveLength(3)
    expect(requests[0]).toContain('ref=main')
    expect(requests[0]).toContain('status=success')
    expect(requests[0]).toContain('per_page=20')
  })

  test('uses a given pipeline id, CI defaults and no header without a token', async () => {
    vi.stubEnv('CI_PROJECT_ID', '7')
    vi.stubEnv('CI_API_V4_URL', 'https://gl.test/api/v4/')
    const calls: Array<[string, Record<string, string>]> = []
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        calls.push([String(input), init?.headers as Record<string, string>])
        return new Response('[]')
      })
    await loadFrom(
      createGitLabCiArtifactProvider({ pipelineId: '55' }, request),
      { fingerprint: 'x' },
    )
    expect(calls).toEqual([
      [
        'https://gl.test/api/v4/projects/7/pipelines/55/jobs?scope%5B%5D=success&per_page=100',
        {},
      ],
    ])
    const none = vi.fn<typeof fetch>()
    await expect(
      loadFrom(
        createGitLabCiArtifactProvider(
          { pipelineId: 'abc', projectId: 1 },
          none,
        ),
        {
          fingerprint: 'x',
        },
      ),
    ).resolves.toBeNull()
    await expect(
      loadFrom(createGitLabCiArtifactProvider({ projectId: ' ' }, none), {
        fingerprint: 'x',
      }),
    ).resolves.toBeNull()
    expect(none).not.toHaveBeenCalled()
  })

  test('skips jobs that are failed, oversized, unnamed or artifact-less', async () => {
    const zipped = archive('gl')
    const downloads: string[] = []
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/pipelines?')) {
        return new Response(
          JSON.stringify([
            { id: 3, status: 'failed' },
            { id: 2, status: 'success' },
          ]),
        )
      }
      if (url.includes('/jobs?')) {
        return new Response(
          JSON.stringify([
            {
              artifacts_file: { filename: 'a' },
              id: 1,
              name: 'tiacore',
              status: 'failed',
            },
            {
              artifacts_file: { filename: 'a', size: 26 * 1024 * 1024 },
              id: 2,
              name: 'tiacore',
              status: 'success',
            },
            {
              artifacts_file: { filename: 'a' },
              id: 3,
              name: 'other',
              status: 'success',
            },
            { id: 4, name: 'tiacore', status: 'success' },
            {
              artifacts_file: { filename: 'a' },
              id: 5,
              name: 'tiacore',
              status: 'success',
            },
          ]),
        )
      }
      downloads.push(url)
      return new Response(zipped)
    })
    const candidates = await loadFrom(
      createGitLabCiArtifactProvider({ projectId: 9 }, request),
      { fingerprint: 'gl' },
    )
    expect(downloads).toEqual([
      'https://gitlab.com/api/v4/projects/9/jobs/5/artifacts',
    ])
    expect(
      candidates?.map((candidate) => [candidate.id, candidate.group]),
    ).toEqual([[5, 2]])
  })
})

const listing = (artifacts: object[]) =>
  new Response(JSON.stringify({ artifacts }))
const item = (id: number, over: object = {}) => ({
  archive_download_url: `https://dl.test/${id}`,
  created_at: `2026-07-${String(10 + id).padStart(2, '0')}T00:00:00Z`,
  expired: false,
  id,
  name: 'tiacore',
  size_in_bytes: 10,
  workflow_run: { head_branch: 'main', id: id * 10 },
  ...over,
})

describe('GitHub Actions provider', () => {
  const options = {
    apiUrl: 'https://api.test/',
    repository: 'o/r',
    tokenEnv: 'TIACORE_TEST_TOKEN',
  }

  test('filters, orders newest first and keeps only maxArtifacts before downloading', async () => {
    vi.stubEnv('GITHUB_RUN_ID', '30')
    const zipped = archive('gh')
    const downloads: string[] = []
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/actions/artifacts')) {
        return listing([
          item(1),
          item(2, { expired: true }),
          item(3),
          item(4, { size_in_bytes: 26 * 1024 * 1024 }),
          item(5, { workflow_run: { head_branch: 'dev', id: 50 } }),
          item(6),
          item(7, { name: 'other' }),
          item(8, { id: 'bad' }),
          item(9),
        ])
      }
      downloads.push(url)
      return new Response(zipped)
    })
    const candidates = await loadFrom(
      createGitHubActionsArtifactProvider(
        { ...options, branch: 'main', maxArtifacts: 2 },
        request,
      ),
      { fingerprint: 'gh' },
    )
    // 3 is the current run (30) and is skipped; 9, 6 are the newest two.
    expect(downloads).toEqual(['https://dl.test/9', 'https://dl.test/6'])
    expect(
      candidates?.map((candidate) => [candidate.id, candidate.group]),
    ).toEqual([
      [9, 90],
      [6, 60],
    ])
  })

  test('sends no authorization without a token and the version headers always', async () => {
    const headers: Array<Record<string, string>> = []
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        headers.push(init?.headers as Record<string, string>)
        return listing([])
      })
    await loadFrom(createGitHubActionsArtifactProvider(options, request), {
      fingerprint: 'x',
    })
    vi.stubEnv('TIACORE_TEST_TOKEN', 'tkn')
    await loadFrom(createGitHubActionsArtifactProvider(options, request), {
      fingerprint: 'x',
    })
    expect(headers).toEqual([
      {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer tkn',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    ])
  })

  test('lists by exact name, by pattern without a name filter, and by run', async () => {
    const urls: string[] = []
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      urls.push(String(input))
      return listing([])
    })
    for (const extra of [
      { artifactName: 'a b' },
      { artifactName: 'tiacore-*' },
      { runId: 99 },
    ]) {
      await loadFrom(
        createGitHubActionsArtifactProvider({ ...options, ...extra }, request),
        {
          fingerprint: 'x',
        },
      )
    }
    expect(urls).toEqual([
      'https://api.test/repos/o/r/actions/artifacts?name=a%20b&per_page=100',
      'https://api.test/repos/o/r/actions/artifacts?per_page=100',
      'https://api.test/repos/o/r/actions/runs/99/artifacts?name=tiacore&per_page=100&direction=desc',
    ])
  })

  test('uses GITHUB_REPOSITORY and refuses a malformed repository without a request', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'env/repo')
    const request = vi.fn<typeof fetch>().mockResolvedValue(listing([]))
    await loadFrom(
      createGitHubActionsArtifactProvider(
        { apiUrl: 'https://api.test' },
        request,
      ),
      { fingerprint: 'x' },
    )
    expect(String(request.mock.calls[0]?.[0])).toContain('/repos/env/repo/')
    const untouched = vi.fn<typeof fetch>()
    for (const repository of ['norepo', 'a/b/c', 'a /b']) {
      await expect(
        loadFrom(
          createGitHubActionsArtifactProvider({ repository }, untouched),
          { fingerprint: 'x' },
        ),
      ).resolves.toBeNull()
    }
    expect(untouched).not.toHaveBeenCalled()
  })

  test('a request that never answers fails at its deadline instead of hanging', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn<typeof fetch>().mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          }),
      )
      const settled = loadFrom(
        createGitHubActionsArtifactProvider(options, request),
        { fingerprint: 'x' },
      ).then(
        () => 'resolved',
        (error: Error) => error.message,
      )
      await vi.advanceTimersByTimeAsync(61_000)
      await expect(settled).resolves.toBe('TIA artifact request timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failing request carries a fixed message and no credential', async () => {
    vi.stubEnv('TIACORE_TEST_TOKEN', 'very-secret-token')
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error('connect ECONNREFUSED Bearer very-secret-token'),
      )
    const failure = await loadFrom(
      createGitHubActionsArtifactProvider(options, request),
      { fingerprint: 'x' },
    ).catch((error: unknown) => error)
    expect(
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ).not.toContain('very-secret-token')
    expect((failure as Error).message).toBe('TIA artifact request failed')
  })
})

const fragment = (index: number, group: string) =>
  graph('parts', {
    complete: false,
    partition: { group, index, total: 2 },
  })

describe('filesystem provider', () => {
  test('reads archives in sorted path order and skips symbolic links', async () => {
    const root = temporaryRoot()
    const out = join(root, 'out')
    mkdirSync(join(out, 'b'), { recursive: true })
    mkdirSync(join(out, 'a'), { recursive: true })
    writeFileSync(join(out, 'b', 'one.zip'), archive('fs'))
    writeFileSync(join(out, 'a', 'two.zip'), archive('fs'))
    writeFileSync(join(out, 'a', 'broken.zip'), 'not a zip')
    writeFileSync(join(out, 'notes.txt'), 'ignored')
    symlinkSync(join(out, 'b'), join(out, 'link'))
    symlinkSync(join(out, 'b', 'one.zip'), join(out, 'linked.zip'))
    const provider = createFilesystemArtifactProvider({
      group: 'g',
      paths: ['out'],
    })
    expect(provider.name).toBe('filesystem artifacts')
    const candidates = (await provider.load({
      fingerprint: 'fs',
      root,
    })) as TiaArtifactCandidate[]
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      join(out, 'a', 'two.zip'),
      join(out, 'b', 'one.zip'),
    ])
    expect(candidates.every((candidate) => candidate.group === 'g')).toBe(true)
    expect(candidates[0]?.graphSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  test('reads a graph store directory and a symlinked top-level path yields nothing', async () => {
    const root = temporaryRoot()
    const store = join(root, 'saved')
    await writeStored(
      store,
      graph('stored', {
        partition: { group: 'shard-group', index: 1, total: 2 },
        complete: false,
      }),
    )
    symlinkSync(store, join(root, 'alias'))
    const provider = createFilesystemArtifactProvider({
      paths: ['saved', 'alias'],
    })
    const candidates = (await provider.load({
      fingerprint: 'stored',
      root,
    })) as TiaArtifactCandidate[]
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      group: 'shard-group',
      id: join(store, 'state.json'),
    })
    expect(candidates[0]?.attestation).toBeUndefined()
    expect(candidates[0]?.graphSha256).toBeUndefined()
    const missing = createFilesystemArtifactProvider({ paths: ['nowhere'] })
    await expect(missing.load({ fingerprint: 'x', root })).resolves.toEqual([])
  })

  test('restores partition fragments of one group and refuses to mix groups', async () => {
    const root = temporaryRoot()
    const zip = (name: string, value: ReturnType<typeof fragment>) =>
      writeFileSync(
        join(root, name),
        zipSync({ 'graph.json': strToU8(JSON.stringify(value)) }),
      )
    zip('a1.zip', fragment(1, 'run-a'))
    zip('b2.zip', fragment(2, 'run-b'))
    zip('a2.zip', fragment(2, 'run-a'))
    const provider = createFilesystemArtifactProvider({ paths: ['.'] })
    // The provider cannot see group on a zip: the partition group is the graph's.
    const result = await restore({
      cacheDir: join(root, '.cache'),
      fingerprint: 'parts',
      log: false,
      providers: [provider],
      root,
      trust: unsigned,
    })
    expect(result).toMatchObject({ restored: true })
    expect(result.artifactId).toEqual([
      join(root, 'a1.zip'),
      join(root, 'a2.zip'),
    ])
  })
})
