import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  runVitestAsync,
} from '../../support/integration-project.ts'

// A real `vitest run` with the observability variables set. The runtime that
// carries the exporters must close once the run is over, or Vitest waits ten
// seconds for the process to end and nothing buffered reaches its destination.

const children: ChildProcess[] = []

afterEach(() => {
  cleanupProjects()
  for (const child of children.splice(0)) child.kill('SIGKILL')
})

describe('vitest run with TIACORE_* exporters', () => {
  test('sends its spans to `tiacore devtools` and lets Vitest exit', async () => {
    const server = spawn(
      process.execPath,
      ['dist/entries/cli.js', 'devtools', '--port', '0', '--interval', '200'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(server)
    let serverOutput = ''
    server.stdout?.on('data', (chunk: Buffer) => (serverOutput += chunk))
    server.stderr?.on('data', (chunk: Buffer) => (serverOutput += chunk))
    const deadline = Date.now() + 15_000
    let port = ''
    while (port === '') {
      port = /ws:\/\/localhost:(\d+)/u.exec(serverOutput)?.[1] ?? ''
      if (Date.now() > deadline) throw new Error(serverOutput)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const root = createFixtureProject('coverage-fidelity')
    const result = await runVitestAsync(root, ['run'], 60_000, {
      TIACORE_DEVTOOLS: `ws://localhost:${port}`,
    })
    expect(result.status, result.output).toBe(0)
    expect(result.output).not.toContain('close timed out')

    const exited = new Promise<void>((resolve) => {
      server.once('exit', () => resolve())
    })
    server.kill('SIGINT')
    await exited
    for (const span of [
      'tia.prepare',
      'tia.vitest.commit',
      'tia.store.commit',
    ]) {
      expect(serverOutput).toContain(span)
    }
    expect(serverOutput).toContain('tia_runs_total')
  }, 120_000)

  test('writes the trace and metrics files when the run ends', async () => {
    const root = createFixtureProject('coverage-fidelity')
    const trace = join(root, 'tia-trace.json')
    const metrics = join(root, 'tia-metrics.prom')
    const result = await runVitestAsync(root, ['run'], 60_000, {
      TIACORE_METRICS_FILE: metrics,
      TIACORE_TRACE_FILE: trace,
    })
    expect(result.status, result.output).toBe(0)
    expect(result.output).not.toContain('close timed out')
    expect(existsSync(trace)).toBe(true)
    const spans: { name: string; status: string }[] = JSON.parse(
      readFileSync(trace, 'utf8'),
    ).spans
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining(['tia.prepare', 'tia.vitest.commit']),
    )
    expect(spans.every((span) => span.status === 'success')).toBe(true)
    expect(readFileSync(metrics, 'utf8')).toMatch(/tia_runs_total/u)
  }, 120_000)
})
