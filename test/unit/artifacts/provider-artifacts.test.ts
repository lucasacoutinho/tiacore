import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { restoreGraphFromArtifacts } from '../../../src/engine/artifacts/restore.js'
import { artifactProviders } from '../../../src/engine/artifacts/restore.js'
import { readGraph } from '../../../src/engine/state/store.js'
import type { TiaRuntimeGraph } from '../../../src/shared/types.js'

const servers: Server[] = []
const temporaryDirectories: string[] = []

function graph(fingerprint: string): TiaRuntimeGraph {
  return {
    baseline: { sha: 'abc', workingTree: {} },
    collectionCoverage: {},
    complete: true,
    coverageComplete: true,
    edges: { 'test/a.test.ts': ['src/a.ts', 'test/a.test.ts'] },
    fingerprint,
    results: {
      a: {
        file: 'test/a.test.ts',
        fullName: 'a',
        id: 'a',
        state: 'passed',
      },
    },
    schema: 3,
    testCoverage: {},
    testEdges: {
      a: {
        file: 'test/a.test.ts',
        files: ['src/a.ts', 'test/a.test.ts'],
      },
    },
    updatedAt: new Date(0).toISOString(),
  }
}

function archive(fingerprint: string): Uint8Array {
  return zipSync({
    'graph.json': strToU8(JSON.stringify(graph(fingerprint))),
  })
}

async function localServer(
  handle: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void,
): Promise<string> {
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

function cacheDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-provider-'))
  temporaryDirectories.push(root)
  return join(root, '.tia')
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('provider-neutral CI artifact discovery', () => {
  test('restores from an authenticated HTTP manifest and archive', async () => {
    vi.stubEnv('TIACORE_MANIFEST_TOKEN', 'manifest-secret')
    const zipped = archive('http-current')
    const requests: Array<{ authorization?: string; path: string }> = []
    let baseUrl = ''
    baseUrl = await localServer((request, response) => {
      requests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        path: request.url ?? '',
      })
      if (request.url === '/manifest.json') {
        response.setHeader('content-type', 'application/json')
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

    const result = await restoreGraphFromArtifacts({
      cacheDir,
      fingerprint: 'http-current',
      log: false,
      providers: artifactProviders({
        provider: 'http-manifest',
        tokenEnv: 'TIACORE_MANIFEST_TOKEN',
        url: `${baseUrl}/manifest.json`,
      }),
    })

    expect(result).toMatchObject({
      artifactId: 'artifact-42',
      provider: 'HTTP artifact manifest',
      restored: true,
    })
    expect(readGraph(cacheDir)?.fingerprint).toBe('http-current')
    expect(requests).toEqual([
      {
        authorization: 'Bearer manifest-secret',
        path: '/manifest.json',
      },
      {
        authorization: 'Bearer manifest-secret',
        path: '/artifact.zip',
      },
    ])
  })

  test('requires promoted artifacts and verifies archive integrity', async () => {
    const zipped = archive('integrity-current')
    const sha256 = createHash('sha256').update(zipped).digest('hex')
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
                sha256,
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

    const result = await restoreGraphFromArtifacts({
      cacheDir: cacheDirectory(),
      fingerprint: 'integrity-current',
      log: false,
      providers: artifactProviders({
        promotedOnly: true,
        provider: 'http-manifest',
        url: `${baseUrl}/manifest.json`,
      }),
    })

    expect(result).toEqual({
      reason: 'no provider returned a compatible artifact',
      restored: false,
    })
    expect(requests).toEqual(['/manifest.json', '/corrupt.zip'])
  })

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

    const result = await restoreGraphFromArtifacts({
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
    })

    expect(result).toMatchObject({
      artifactId: 900,
      provider: 'GitLab CI',
      restored: true,
    })
    expect(readGraph(cacheDir)?.fingerprint).toBe('gitlab-current')
    expect(requests).toHaveLength(3)
  })
})
