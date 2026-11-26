import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createGitLabCiArtifactProvider } from '../../src/engine/artifacts/gitlab-ci.ts'
import { getBytes } from '../../src/engine/artifacts/http.ts'
import { archive, cacheDirectory, readStored, restore } from './support.ts'

// Redirects, followed with the real fetch between real servers. A redirect to
// another origin must not carry the caller's headers: fetch strips only
// Authorization, so a GitLab JOB-TOKEN would reach the object store.

const servers: Server[] = []

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
    throw new Error('redirect fixture server did not bind')
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

const token = { 'JOB-TOKEN': 'job-secret' }

const get = (url: string, request: typeof fetch = globalThis.fetch) =>
  Effect.runPromise(getBytes(request, url, token, 1024 * 1024))

const text = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes)

const moved = (response: ServerResponse, location: string, status = 302) =>
  response.writeHead(status, { location }).end('moved')

describe('following redirects', () => {
  test('a redirect to another origin drops the caller headers and still returns the body', async () => {
    const seen: Array<[string, unknown]> = []
    const storage = await localServer((request, response) => {
      seen.push([`storage ${request.url}`, request.headers['job-token']])
      response.end('archive bytes')
    })
    const api = await localServer((request, response) => {
      seen.push([`api ${request.url}`, request.headers['job-token']])
      moved(response, `${storage}/bucket/object?signature=x`)
    })

    expect(text(await get(`${api}/jobs/1/artifacts`))).toBe('archive bytes')
    expect(seen).toEqual([
      ['api /jobs/1/artifacts', 'job-secret'],
      ['storage /bucket/object?signature=x', undefined],
    ])
  })

  test('a same-origin redirect keeps them, and once the origin changes they stay dropped', async () => {
    const seen: Array<[string, unknown]> = []
    let api = ''
    const storage = await localServer((request, response) => {
      seen.push([`storage ${request.url}`, request.headers['job-token']])
      moved(response, `${api}/back`)
    })
    api = await localServer((request, response) => {
      seen.push([`api ${request.url}`, request.headers['job-token']])
      if (request.url === '/same') return moved(response, '/final', 307)
      if (request.url === '/away') return moved(response, `${storage}/bounce`)
      response.end(`body of ${request.url}`)
    })

    expect(text(await get(`${api}/same`))).toBe('body of /final')
    expect(text(await get(`${api}/away`))).toBe('body of /back')
    expect(seen).toEqual([
      ['api /same', 'job-secret'],
      ['api /final', 'job-secret'],
      ['api /away', 'job-secret'],
      ['storage /bounce', undefined],
      ['api /back', undefined],
    ])
  })

  test('follows every redirect status a GET can receive', async () => {
    const statuses: Record<string, [number, string]> = {
      '/a': [301, '/b'],
      '/b': [302, '/c'],
      '/c': [303, '/d'],
      '/d': [307, '/e'],
      '/e': [308, '/f'],
    }
    const api = await localServer((request, response) => {
      const next = statuses[request.url ?? '']
      if (next === undefined) return response.end('arrived')
      moved(response, next[1], next[0])
    })
    expect(text(await get(`${api}/a`))).toBe('arrived')
  })

  test('a redirect without a usable http(s) location yields nothing', async () => {
    const api = await localServer((request, response) => {
      if (request.url === '/none') return response.writeHead(302).end()
      if (request.url === '/ftp') return moved(response, 'ftp://example.test/x')
      if (request.url === '/file') return moved(response, 'file:///etc/passwd')
      moved(response, 'http://[')
    })
    for (const path of ['/none', '/ftp', '/file', '/broken']) {
      await expect(get(`${api}${path}`)).resolves.toBeNull()
    }
  })

  test('gives up after five redirects with the fixed failure message', async () => {
    const hops: string[] = []
    const api = await localServer((request, response) => {
      hops.push(request.url ?? '')
      moved(response, `/hop/${hops.length}`)
    })
    const failure = await get(`${api}/hop/0`).catch((error: unknown) => error)
    expect((failure as Error).message).toBe('TIA artifact request failed')
    expect(
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ).not.toContain('job-secret')
    expect(hops).toEqual([
      '/hop/0',
      '/hop/1',
      '/hop/2',
      '/hop/3',
      '/hop/4',
      '/hop/5',
    ])
  })

  test('a redirect body is dropped instead of holding its connection', async () => {
    const api = await localServer((request, response) => {
      if (request.url === '/moved') {
        response.writeHead(302, { location: '/ok' })
        response.end('x'.repeat(256 * 1024))
        return
      }
      response.end('ok')
    })
    const server = servers.at(-1)!
    for (let index = 0; index < 30; index += 1) {
      expect(text(await get(`${api}/moved`))).toBe('ok')
    }
    // Give a cancelled body time to close its socket.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const open = await new Promise<number>((resolve) => {
      server.getConnections((_error, count) => resolve(count))
    })
    // A few idle keep-alive sockets are the pool; a leak would be one per hop.
    expect(open).toBeLessThanOrEqual(4)
  })

  test('one deadline covers every hop', async () => {
    vi.useFakeTimers()
    try {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(null, {
            headers: { location: 'https://storage.test/object' },
            status: 302,
          }),
        )
        .mockImplementation(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              )
            }),
        )
      const settled = get('https://api.test/artifacts', request).then(
        () => 'resolved',
        (error: Error) => error.message,
      )
      await vi.advanceTimersByTimeAsync(61_000)
      await expect(settled).resolves.toBe('TIA artifact request timed out')
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GitLab CI artifacts behind a redirect', () => {
  test('restores from object storage without sending it the job token', async () => {
    vi.stubEnv('TIACORE_GITLAB_TOKEN', 'gitlab-secret')
    vi.stubEnv('CI_PIPELINE_ID', '101')
    const zipped = archive('gitlab-redirect')
    const storageTokens: unknown[] = []
    const storage = await localServer((request, response) => {
      storageTokens.push(request.headers['job-token'])
      response.end(Buffer.from(zipped))
    })
    const api = await localServer((request, response) => {
      expect(request.headers['job-token']).toBe('gitlab-secret')
      if (request.url?.startsWith('/api/v4/projects/42/pipelines/100/jobs?')) {
        response.end(
          JSON.stringify([
            {
              artifacts_file: { filename: 'tiacore.zip', size: zipped.length },
              id: 900,
              name: 'tiacore',
              status: 'success',
            },
          ]),
        )
        return
      }
      if (request.url === '/api/v4/projects/42/jobs/900/artifacts') {
        moved(response, `${storage}/artifacts/900.zip?X-Amz-Signature=x`)
        return
      }
      response.writeHead(404).end()
    })
    const cacheDir = cacheDirectory()

    const result = await restore({
      cacheDir,
      fingerprint: 'gitlab-redirect',
      log: false,
      providers: [
        createGitLabCiArtifactProvider({
          apiUrl: `${api}/api/v4`,
          pipelineId: 100,
          projectId: 42,
          tokenEnv: 'TIACORE_GITLAB_TOKEN',
        }),
      ],
      trust: { allowUnsigned: true },
    })

    expect(result).toMatchObject({ artifactId: 900, restored: true })
    expect((await readStored(cacheDir))?.fingerprint).toBe('gitlab-redirect')
    expect(storageTokens).toEqual([undefined])
  })
})
