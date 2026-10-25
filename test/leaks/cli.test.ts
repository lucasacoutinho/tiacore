import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { execute } from '../../src/cli/main.ts'
import { assertNoLeak } from '../support/leak.ts'

// NF-MEM: a process that runs the CLI in-process again and again (a test
// suite, an editor integration, `runCli` from a script) retains nothing per
// invocation: not the Effect layers, the observability exporters, the signal
// listeners or the devtools server socket.

let directory = ''
let graph = ''

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'tiacore-cli-leak-'))
  graph = join(directory, 'graph.json')
  writeFileSync(
    graph,
    JSON.stringify({
      complete: true,
      environmentFingerprint: 'local',
      fingerprint: 'project',
      observations: [],
      protocolVersion: 1,
      suites: [],
    }),
  )
})

afterAll(() => {
  rmSync(directory, { force: true, recursive: true })
})

describe('CLI invocations', () => {
  test('commands that read a graph retain nothing', async () => {
    const output = join(directory, 'out.json')
    const result = await assertNoLeak(
      async () => {
        expect(
          await execute(['inspect', '--graph', graph, '--output', output]),
        ).toEqual({ code: 0 })
        expect(
          await execute(['doctor', '--graph', graph, '--output', output]),
        ).toEqual({ code: 0 })
      },
      { bytesPerOperation: 16_384, iterations: 60 },
    )
    expect(result.bytesPerOperation).toBeLessThan(16_384)
  }, 120_000)

  test('a failing command retains nothing either', async () => {
    const result = await assertNoLeak(
      async () => {
        const outcome = await execute([
          'inspect',
          '--graph',
          join(directory, 'missing.json'),
        ])
        expect(outcome.code).toBe(1)
      },
      { bytesPerOperation: 16_384, iterations: 60 },
    )
    expect(result.bytesPerOperation).toBeLessThan(16_384)
  }, 120_000)

  test('the install check retains nothing and leaves the project alone', async () => {
    const project = mkdtempSync(join(tmpdir(), 'tiacore-doctor-leak-'))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project)
    const output = join(directory, 'doctor.json')
    try {
      const result = await assertNoLeak(
        async () => {
          expect(await execute(['doctor', '--output', output])).toEqual({
            code: 0,
          })
        },
        { bytesPerOperation: 32_768, iterations: 30 },
      )
      expect(result.bytesPerOperation).toBeLessThan(32_768)
      expect(readdirSync(project)).toEqual([])
    } finally {
      cwd.mockRestore()
      rmSync(project, { force: true, recursive: true })
    }
  }, 120_000)

  test('starting and stopping the devtools server leaves no listener, socket or fiber', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const interrupt = process.listeners('SIGINT')
    const terminate = process.listeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
    try {
      const result = await assertNoLeak(
        async () => {
          const running = execute([
            'devtools',
            '--port',
            '0',
            '--interval',
            '60000',
          ])
          // Wait for the command to install its signal listener.
          while (process.listenerCount('SIGINT') === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          process.emit('SIGINT')
          expect(await running).toEqual({ code: 0 })
          expect(process.listenerCount('SIGINT')).toBe(0)
          expect(process.listenerCount('SIGTERM')).toBe(0)
        },
        { batches: 3, bytesPerOperation: 32_768, iterations: 10 },
      )
      expect(result.bytesPerOperation).toBeLessThan(32_768)
    } finally {
      for (const listener of interrupt) process.on('SIGINT', listener)
      for (const listener of terminate) process.on('SIGTERM', listener)
      write.mockRestore()
    }
  }, 120_000)
})
