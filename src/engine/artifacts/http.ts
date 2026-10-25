import * as Effect from 'effect/Effect'

import { TiaIo } from '../../wire/errors.ts'

// The one place artifact providers touch the network. The fetch is injected
// (tests and users supply their own), every request has a deadline, and a
// failure carries a fixed message: never the request, its headers or the
// underlying error, which could name a credential.

export type Fetch = typeof globalThis.fetch

/** Deadline for one request including its body. */
export const REQUEST_TIMEOUT_MS = 60_000
/** Largest JSON listing a provider reads from a CI API. */
export const MAX_LISTING_BYTES = 10 * 1024 * 1024

/** Gives up on a body so its connection is released instead of held until the server finishes. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The body was already closed or locked.
  }
}

async function readBounded(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await discard(response)
    return null
  }

  const reader = response.body?.getReader()
  if (reader === undefined) {
    return null
  }

  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }

      length += chunk.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
  } catch {
    return null
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Streams a response body and stops, cancelling the reader, as soon as it
 * passes `maximumBytes`. Null when it is too large (by header or by count),
 * has no body or fails while reading.
 */
export const readBoundedResponse = (response: Response, maximumBytes: number) =>
  Effect.promise(() => readBounded(response, maximumBytes))

const unavailable = () => new TiaIo({ message: 'TIA artifact request failed' })

/**
 * GETs `url` following redirects and reads at most `maximumBytes`. Null for a
 * non-OK status or an oversized body; a failure for a network error or when
 * the deadline passes.
 */
export const getBytes = (
  request: Fetch,
  url: string | URL,
  headers: Record<string, string>,
  maximumBytes: number,
): Effect.Effect<Uint8Array | null, TiaIo> =>
  Effect.tryPromise({
    catch: unavailable,
    try: async (signal) => {
      const response = await request(url, {
        headers,
        redirect: 'follow',
        signal,
      })
      if (response.ok) return await readBounded(response, maximumBytes)
      await discard(response)
      return null
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(new TiaIo({ message: 'TIA artifact request timed out' })),
    }),
  )

/** Like `getBytes`, parsed as JSON; null when the body is not JSON. */
export const getJson = (
  request: Fetch,
  url: string | URL,
  headers: Record<string, string>,
  maximumBytes: number,
): Effect.Effect<unknown, TiaIo> =>
  getBytes(request, url, headers, maximumBytes).pipe(
    Effect.map((bytes) => {
      if (bytes === null) return null
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown
      } catch {
        return null
      }
    }),
  )
