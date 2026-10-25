import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Metric from 'effect/Metric'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { startDevtoolsServer } from '../../src/host/devtools-server.ts'
import { observeLayer, serverReachable } from '../../src/host/observe.ts'
import { SpanBook } from '../../src/host/span-book.ts'
import { TiaIo } from '../../src/wire/errors.ts'
import { assertNoLeak } from '../support/leak.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const stage = Effect.fn('tia.test.stage')(function* (value: number) {
  yield* Effect.sleep(2)
  return value * 2
})

const failingStage = Effect.fn('tia.test.failing')(function* () {
  return yield* new TiaIo({ message: 'store is locked' })
})

/** Polls until `ready` holds; fails after `timeoutMs`. */
const until = (ready: () => boolean, timeoutMs = 10_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!ready()) {
      if (Date.now() > deadline)
        return yield* Effect.die(new Error(`timed out waiting for ${ready}`))
      yield* Effect.sleep(10)
    }
  })

/** Runs `body` with a devtools server on a free port; the server stops after. */
const withServer = <A>(
  body: (server: { book: SpanBook; url: string }) => Effect.Effect<A>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const book = new SpanBook()
        const running = yield* startDevtoolsServer({
          book,
          metricsIntervalMs: 25,
          port: 0,
        })
        yield* Effect.forkScoped(running.serve)
        return yield* body({ book, url: `ws://localhost:${running.port}` })
      }),
    ),
  )

describe('tiacore devtools server', () => {
  test('receives the spans and metrics of a process that runs with TIACORE_DEVTOOLS', async () => {
    await withServer(({ book, url }) =>
      Effect.gen(function* () {
        const client = ManagedRuntime.make(observeLayer({ devtools: url }))
        yield* Effect.promise(() => client.runPromise(stage(21)))
        yield* Effect.promise(() =>
          client.runPromise(
            failingStage().pipe(
              Effect.ignore,
              Effect.andThen(
                Metric.update(Metric.gauge('tia_test_devtools_gauge'), 9),
              ),
            ),
          ),
        )
        // The client answers metrics requests while it runs; one sent when it
        // closes can be lost, so give the server time to ask.
        yield* Effect.sleep(100)
        yield* Effect.promise(() => client.dispose())
        yield* until(() => book.summary().ended >= 2)
        const summary = book.summary()
        expect(summary.names.map((stats) => stats.name).sort()).toEqual([
          'tia.test.failing',
          'tia.test.stage',
        ])
        expect(summary.failed[0]).toMatchObject({ name: 'tia.test.failing' })
        expect(summary.failed[0]?.message).toContain('store is locked')
        expect(summary.slowest[0]?.durationMs).toBeGreaterThan(0)
        // The client sends its metrics when it is asked and when it closes.
        yield* until(() =>
          book
            .summary()
            .metrics.some(
              (metric) => metric.name === 'tia_test_devtools_gauge',
            ),
        )
        expect(
          book
            .summary()
            .metrics.find((metric) => metric.name === 'tia_test_devtools_gauge')
            ?.value,
        ).toBe('9')
      }),
    )
  })

  test('tells the user when nobody listens and sends nothing', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const closed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* startDevtoolsServer({
            book: new SpanBook(),
            port: 0,
          })
          return running.port
        }),
      ),
    )
    const url = `ws://localhost:${closed}`
    await expect(serverReachable(url)).resolves.toBe(false)
    const runtime = ManagedRuntime.make(observeLayer({ devtools: url }))
    await expect(runtime.runPromise(stage(1))).resolves.toBe(2)
    await runtime.dispose()
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('tiacore devtools'),
    )
  })

  test('reports a port that is already in use', async () => {
    await withServer(({ url }) =>
      Effect.gen(function* () {
        const port = Number(new URL(url).port)
        const error = yield* Effect.scoped(
          startDevtoolsServer({ book: new SpanBook(), port }),
        ).pipe(Effect.flip, Effect.orDie)
        expect(error).toBeInstanceOf(TiaIo)
        expect(error.message).toContain(`cannot listen on localhost:${port}`)
      }),
    )
  })

  test('retains nothing across client connects and disconnects', async () => {
    await withServer(({ book, url }) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          assertNoLeak(
            async () => {
              const client = ManagedRuntime.make(
                observeLayer({ devtools: url }),
              )
              await client.runPromise(stage(1))
              await client.dispose()
            },
            { batches: 3, bytesPerOperation: 16_384, iterations: 12 },
          ),
        )
        expect(result.bytesPerOperation).toBeLessThan(16_384)
        yield* until(() => book.summary().clients === 0)
        const summary = book.summary()
        expect(summary.connections).toBeGreaterThanOrEqual(48)
        expect(summary.open).toBe(0)
      }),
    )
  }, 120_000)
})
