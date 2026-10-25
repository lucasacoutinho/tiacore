import * as NodeSocketServer from '@effect/platform-node/NodeSocketServer'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import * as DevToolsServer from 'effect/devtools/DevToolsServer'
import * as SocketServer from 'effect/socket/SocketServer'

import { TiaIo } from '../wire/errors.ts'
import type { SpanBook } from './span-book.ts'

/** Fewest milliseconds between two metrics requests that follow ended spans. */
const MIN_ASK_GAP_MS = 250

export interface DevtoolsServerOptions {
  readonly book: SpanBook
  /** The interface to listen on; defaults to localhost. */
  readonly host?: string
  /** How often the server asks each client for a metrics snapshot. */
  readonly metricsIntervalMs?: number
  readonly port: number
}

export interface RunningDevtoolsServer {
  /** The port the server is bound to; differs from the request for port 0. */
  readonly port: number
  /** Serves clients until interrupted. */
  readonly serve: Effect.Effect<never, TiaIo>
}

/**
 * Listens for Effect devtools clients and files what they send in
 * `options.book`. The socket closes with the surrounding scope. Failing to
 * listen (for example a port in use) is a `TiaIo` failure.
 */
export const startDevtoolsServer = Effect.fnUntraced(function* (
  options: DevtoolsServerOptions,
): Effect.fn.Return<RunningDevtoolsServer, TiaIo, Scope.Scope> {
  const host = options.host ?? 'localhost'
  const server = yield* NodeSocketServer.makeWebSocket({
    host,
    port: options.port,
  }).pipe(
    Effect.mapError(
      (error) =>
        new TiaIo({
          cause: error,
          message: `cannot listen on ${host}:${options.port}: ${causeMessage(error)}`,
        }),
    ),
  )
  const interval = options.metricsIntervalMs ?? 2_000
  const handle = Effect.fnUntraced(function* (client: DevToolsServer.Client) {
    const id = options.book.connect()
    let lastAsk = Date.now()
    const ask = client.send({ _tag: 'MetricsRequest' })
    // Metrics only travel when asked, so ask on a timer and after spans end.
    yield* Effect.forkChild(
      ask.pipe(Effect.andThen(Effect.sleep(interval)), Effect.forever),
    )
    yield* Queue.take(client.queue).pipe(
      Effect.flatMap((request) =>
        Effect.suspend(() => {
          options.book.ingest(id, request)
          const now = Date.now()
          if (
            request._tag === 'Span' &&
            request.status._tag === 'Ended' &&
            now - lastAsk >= MIN_ASK_GAP_MS
          ) {
            lastAsk = now
            return ask
          }
          return Effect.void
        }),
      ),
      Effect.forever,
      // A queue that shuts down means the client disconnected.
      Effect.ignoreCause,
      Effect.ensuring(Effect.sync(() => options.book.disconnect(id))),
    )
  })
  return {
    port: 'port' in server.address ? server.address.port : options.port,
    serve: DevToolsServer.run(handle).pipe(
      Effect.provideService(SocketServer.SocketServer, server),
      Effect.mapError(
        (error) =>
          new TiaIo({
            cause: error,
            message: `devtools server stopped: ${causeMessage(error)}`,
          }),
      ),
    ),
  }
})

function causeMessage(error: unknown): string {
  const cause =
    typeof error === 'object' && error !== null && 'reason' in error
      ? error.reason
      : error
  const inner =
    typeof cause === 'object' && cause !== null && 'cause' in cause
      ? cause.cause
      : cause
  return inner instanceof Error ? inner.message : String(inner)
}
