import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'

import { DEFAULT_DEVTOOLS_PORT } from '../core/defaults.ts'
import { TiaInvalid } from '../wire/errors.ts'

/** The server loads on first use so `--help` and the other commands stay fast. */
const programs = () =>
  Effect.promise(async () => ({
    ...(await import('../host/devtools-server.ts')),
    ...(await import('../host/span-book.ts')),
    ...(await import('../host/span-render.ts')),
  }))

const CLEAR_SCREEN = '\u001B[2J\u001B[H'

/** Completes once the user presses Ctrl-C or the process is asked to stop. */
const stopSignal = Effect.callback<void>((resume) => {
  const release = () => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  // Either signal ends the wait, and both listeners go with it: the cleanup
  // below only runs when the wait is interrupted.
  const stop = () => {
    release()
    resume(Effect.void)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return Effect.sync(release)
})

export const devtoolsCommand = Command.make(
  'devtools',
  {
    host: Flag.String('host').pipe(
      Flag.withDescription('interface to listen on'),
      Flag.withDefault('localhost'),
    ),
    interval: Flag.Int('interval').pipe(
      Flag.withDescription('milliseconds between summaries'),
      Flag.withDefault(1_000),
    ),
    port: Flag.Int('port').pipe(
      Flag.withDescription('port to listen on; 0 picks a free one'),
      Flag.withDefault(DEFAULT_DEVTOOLS_PORT),
    ),
  },
  Effect.fn('tia.cli.devtools')(function* (options) {
    if (options.port < 0 || options.port > 65_535) {
      return yield* new TiaInvalid({
        message: `--port must be between 0 and 65535, got ${options.port}`,
      })
    }
    if (options.interval < 50) {
      return yield* new TiaInvalid({
        message: `--interval must be at least 50, got ${options.interval}`,
      })
    }
    const { SpanBook, renderSummary, startDevtoolsServer } = yield* programs()
    yield* Effect.scoped(
      Effect.gen(function* () {
        const book = new SpanBook()
        const running = yield* startDevtoolsServer({
          book,
          host: options.host,
          port: options.port,
        })
        const address = `ws://${options.host}:${running.port}`
        const title = `tiacore devtools ${address}`
        const footer = `Send spans here with TIACORE_DEVTOOLS=${address}. Press Ctrl-C to stop.`
        const interactive = process.stdout.isTTY
        let drawn = -1
        const draw = Effect.sync(() => {
          if (book.version === drawn) return
          drawn = book.version
          const frame = renderSummary(book.summary(), { footer, title })
          process.stdout.write(
            interactive ? CLEAR_SCREEN + frame : `\n${frame}`,
          )
        })
        const refresh = draw.pipe(
          Effect.andThen(Effect.sleep(options.interval)),
          Effect.forever,
        )
        yield* Effect.raceFirst(
          Effect.all([running.serve, refresh], {
            concurrency: 'unbounded',
            discard: true,
          }),
          stopSignal,
        )
        drawn = -1
        yield* draw
      }),
    )
  }),
).pipe(
  Command.withDescription(
    'Listen for spans and metrics from tiacore processes run with TIACORE_DEVTOOLS',
  ),
)
