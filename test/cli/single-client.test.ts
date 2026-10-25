import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { afterEach, describe, expect, test } from 'vitest'

import { startDevtoolsServer } from '../../src/host/devtools-server.ts'
import {
  disposeHost,
  IDLE_DISPOSE_MS,
  runExit,
  runPromise,
} from '../../src/host/runtime.ts'
import { SpanBook } from '../../src/host/span-book.ts'

// One observability client per process. `tiacore doctor --perf` is the one
// command that runs engine code (prepare and commit, through `runPromise`)
// from inside the CLI program, so it reaches both of the places that used to
// build their own exporters: the CLI layer and the process-wide runtime.

const cli = fileURLToPath(new URL('../../dist/entries/cli.js', import.meta.url))

const directories: string[] = []
const servers: (() => Promise<void>)[] = []
const saved: Record<string, string | undefined> = {}

afterEach(async () => {
  await disposeHost()
  for (const stop of servers.splice(0)) await stop()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const path of directories.splice(0))
    rmSync(path, { force: true, recursive: true })
})

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-single-client-'))
  directories.push(path)
  return path
}

/** A devtools server on a free port that files what it receives in `book`. */
async function listen(book: SpanBook): Promise<number> {
  const scope = Scope.makeUnsafe()
  const running = await Effect.runPromise(
    startDevtoolsServer({ book, metricsIntervalMs: 50, port: 0 }).pipe(
      Scope.provide(scope),
    ),
  )
  Effect.runFork(Effect.forkIn(running.serve, scope))
  servers.push(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  return running.port
}

interface Finished {
  readonly code: number | null
  readonly stderr: string
}

/** Runs `tiacore <args>` as a real process and waits for it to end. */
function tiacore(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

async function until(ready: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${ready}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('one client per process', () => {
  test('a command and the engine runs it starts share one devtools connection', async () => {
    const book = new SpanBook()
    const port = await listen(book)
    const finished = await tiacore(scratch(), ['doctor', '--perf', '--json'], {
      TIACORE_DEVTOOLS: `ws://localhost:${port}`,
    })
    expect(finished.code, finished.stderr).toBe(0)
    expect(finished.stderr).toBe('')
    await until(() => book.summary().clients === 0)
    const summary = book.summary()
    // Both layers of the program reported: the CLI command and the engine.
    expect(summary.names.map((stats) => stats.name)).toEqual(
      expect.arrayContaining(['tia.cli.doctor', 'tia.prepare', 'tia.commit']),
    )
    expect(summary.connections).toBe(1)
    expect(new Set(summary.slowest.map((span) => span.client))).toEqual(
      new Set([1]),
    )
  }, 60_000)

  test('a command and the engine runs it starts share one OTLP exporter stack', async () => {
    const requests: string[] = []
    const collector = createServer((request: IncomingMessage, response) => {
      request.resume()
      request.once('end', () => {
        requests.push(request.url ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
    })
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    )
    try {
      const address = collector.address()
      if (address === null || typeof address === 'string')
        throw new Error('the collector has no port')
      const finished = await tiacore(
        scratch(),
        ['doctor', '--perf', '--json'],
        { TIACORE_OTLP_URL: `http://127.0.0.1:${address.port}` },
      )
      expect(finished.code, finished.stderr).toBe(0)
      // Every exporter stack sends what it holds once when it closes, and the
      // run is shorter than the export interval, so one stack is one request
      // per signal.
      expect(requests.filter((url) => url.endsWith('/v1/traces'))).toHaveLength(
        1,
      )
      expect(
        requests.filter((url) => url.endsWith('/v1/metrics')),
      ).toHaveLength(1)
    } finally {
      await new Promise((resolve) => collector.close(resolve))
    }
  }, 60_000)

  test('runExit and runPromise run on the same runtime', async () => {
    const book = new SpanBook()
    const port = await listen(book)
    saved['TIACORE_DEVTOOLS'] = process.env['TIACORE_DEVTOOLS']
    process.env['TIACORE_DEVTOOLS'] = `ws://localhost:${port}`
    const nested = Effect.fn('tia.test.outer')(function* () {
      yield* Effect.promise(() =>
        runPromise(Effect.void.pipe(Effect.withSpan('tia.test.inner'))),
      )
    })
    // A pause longer than the idle limit between the two runs must not close
    // the runtime under the command that is still running.
    const exit = await runExit(
      nested().pipe(
        Effect.andThen(Effect.sleep(IDLE_DISPOSE_MS + 200)),
        Effect.andThen(nested()),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    await disposeHost()
    await until(() => book.summary().clients === 0)
    const summary = book.summary()
    expect(summary.names.map((stats) => stats.name).sort()).toEqual([
      'tia.test.inner',
      'tia.test.outer',
    ])
    expect(summary.connections).toBe(1)
  })
})
