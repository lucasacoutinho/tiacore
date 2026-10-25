import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import * as Effect from 'effect/Effect'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { getBytes, getJson } from '../../src/engine/artifacts/http.ts'
import {
  clearSourceMapCaches,
  coveredSourceMapFiles,
} from '../../src/runners/playwright/source-maps.ts'
import { activeHandles, assertNoLeak, waitForHandles } from '../support/leak.ts'

// NF-MEM: artifact providers fetch listings and archives from CI APIs. Every
// response body is read to the limit and cancelled, or dropped, so a request
// that is refused, too large or cut off leaves no socket or stream behind.

const LIMIT = 64 * 1024

let server: Server
let base = ''
let baseline = 0

beforeAll(async () => {
  server = createServer((request, response) => {
    switch (request.url?.split('?')[0]) {
      case '/ok':
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ artifacts: [1, 2, 3] }))
        return
      case '/missing':
        response.statusCode = 404
        response.end('not found')
        return
      case '/huge':
        response.setHeader('content-length', String(64 * 1024 * 1024))
        response.write('x'.repeat(1024))
        return
      case '/declared-large':
        response.setHeader('content-length', String(LIMIT * 4))
        response.write('x'.repeat(1024))
        // The body never finishes; the client must give up on its own.
        return
      case '/streamed-large': {
        const timer = setInterval(() => {
          if (response.destroyed) {
            clearInterval(timer)
            return
          }
          response.write(Buffer.alloc(16 * 1024, 1))
        }, 1)
        response.on('close', () => clearInterval(timer))
        return
      }
      case '/dropped':
        response.setHeader('content-length', '4096')
        response.write('partial')
        setTimeout(() => response.destroy(), 5)
        return
      default:
        response.statusCode = 500
        response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  baseline = activeHandles()
})

beforeEach(async () => {
  // Idle keep-alive sockets of earlier tests are not what is being counted;
  // the pause lets the client notice they are gone before it reuses one.
  server.closeAllConnections()
  await new Promise((resolve) => setTimeout(resolve, 100))
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const get = (path: string) =>
  Effect.runPromise(getBytes(fetch, `${base}${path}`, {}, LIMIT))

function connections(): Promise<number> {
  return new Promise((resolve) => {
    server.getConnections((_error, count) => resolve(count))
  })
}

describe('artifact provider requests', () => {
  test('a response that is refused or too large does not hold its connection', async () => {
    for (let index = 0; index < 30; index += 1) {
      await get('/declared-large')
      await get('/streamed-large')
    }
    // Give a cancelled body time to close its socket.
    await new Promise((resolve) => setTimeout(resolve, 300))
    // A few idle keep-alive sockets are the pool; a leak would be one per request.
    expect(await connections()).toBeLessThanOrEqual(4)
  })

  test('the Playwright source-map fetch does not hold a refused or oversized body either', async () => {
    for (let index = 0; index < 20; index += 1) {
      for (const path of ['missing', 'huge']) {
        const script = `a();\n//# ${'sourceMappingURL'}=${base}/${path}?n=${index}`
        await coveredSourceMapFiles(
          `${base}/app.js`,
          script,
          [
            {
              ranges: [{ count: 1, endOffset: script.length, startOffset: 0 }],
            },
          ],
          '/project',
        )
      }
    }
    clearSourceMapCaches()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // A few idle keep-alive sockets are the pool; a leak would be one per request.
    expect(await connections()).toBeLessThanOrEqual(4)
  })

  test('each kind of response is read or dropped without keeping anything', async () => {
    await expect(get('/ok')).resolves.toBeInstanceOf(Uint8Array)
    await expect(get('/missing')).resolves.toBeNull()
    await expect(get('/declared-large')).resolves.toBeNull()
    await expect(get('/streamed-large')).resolves.toBeNull()
    await expect(get('/dropped')).resolves.toBeNull()
    await expect(
      Effect.runPromise(getJson(fetch, `${base}/ok`, {}, LIMIT)),
    ).resolves.toEqual({ artifacts: [1, 2, 3] })
  })

  test('repeated requests retain no heap, and their sockets close', async () => {
    const result = await assertNoLeak(
      async () => {
        await get('/ok')
        await get('/missing')
        await get('/declared-large')
        await get('/streamed-large')
        await get('/dropped')
      },
      {
        batches: 3,
        bytesPerOperation: 16_384,
        // Keep-alive sockets close on their own timer, so they are checked below.
        handles: false,
        iterations: 20,
      },
    )
    expect(result.bytesPerOperation).toBeLessThan(16_384)
    server.closeAllConnections()
    await waitForHandles(baseline)
  }, 120_000)
})
