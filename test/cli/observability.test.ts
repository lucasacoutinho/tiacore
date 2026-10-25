import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { execute } from '../../src/cli/main.ts'
import type { PerfReport } from '../../src/cli/doctor-perf.ts'
import { NODE_ENGINES } from '../../src/core/version.ts'

const cli = fileURLToPath(new URL('../../dist/entries/cli.js', import.meta.url))

const directories: string[] = []
const children: ChildProcess[] = []

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'tiacore-observability-'))
  directories.push(path)
  return path
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const path of directories.splice(0)) {
    chmodSync(path, 0o755)
    rmSync(path, { force: true, recursive: true })
  }
})

interface DoctorOutput {
  checks: { detail: string; id: string; status: string; title: string }[]
  ok: boolean
  perf?: PerfReport
  tiacore: string
}

function doctor(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, 'doctor', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return result
}

describe('tiacore doctor', () => {
  test('checks the install and prints JSON', () => {
    const cwd = scratch()
    const result = doctor(cwd, ['--json'])
    expect(result.status).toBe(0)
    const report: DoctorOutput = JSON.parse(result.stdout)
    expect(report.ok).toBe(true)
    const ids = report.checks.map((check) => check.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'node',
        'git',
        'peer:vitest',
        'typescript',
        'cache',
        'crash',
      ]),
    )
    const node = report.checks.find((check) => check.id === 'node')
    expect(node).toMatchObject({ status: 'ok' })
    expect(node?.detail).toContain(NODE_ENGINES)
    expect(report.perf).toBeUndefined()
  })

  test('prints readable text by default', () => {
    const result = doctor(scratch(), [])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('tiacore doctor')
    expect(result.stdout).toMatch(/ok\s+Node\.js/u)
    expect(result.stdout).toContain('No problems found.')
  })

  test('never writes to the project it checks', () => {
    const cwd = scratch()
    writeFileSync(join(cwd, 'package.json'), '{"name":"user-project"}\n')
    const before = readdirSync(cwd, { recursive: true }).sort()
    const result = doctor(cwd, ['--perf', '--json'])
    expect(result.status).toBe(0)
    expect(readdirSync(cwd, { recursive: true }).sort()).toEqual(before)
  })

  test('with --perf it times a cold prepare and a commit and ranks the phases', () => {
    const cwd = scratch()
    const temporaryRoot = scratch()
    const result = doctor(cwd, ['--perf', '--json'], { TMPDIR: temporaryRoot })
    expect(result.status).toBe(0)
    const report: DoctorOutput = JSON.parse(result.stdout)
    const perf = report.perf
    expect(perf?.project.testFiles).toBeGreaterThan(0)
    const phases = perf?.phases ?? []
    expect(phases.map((phase) => phase.name)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('prepare (cold'),
        expect.stringContaining('commit'),
        expect.stringContaining('prepare (warm'),
      ]),
    )
    expect(phases.every((phase) => phase.milliseconds > 0)).toBe(true)
    // Slowest first.
    const times = phases.map((phase) => phase.milliseconds)
    expect(times).toEqual(times.toSorted((a, b) => b - a))
    const spans = perf?.spans.map((span) => span.name) ?? []
    expect(spans).toEqual(
      expect.arrayContaining([
        'tia.prepare',
        'tia.commit',
        'tia.baseline.snapshot',
        'tia.store.commit',
      ]),
    )
    // The throwaway project is gone. Node's compile cache, which the bin
    // enables, stays in the temp directory by design.
    expect(
      readdirSync(temporaryRoot).filter(
        (entry) => entry !== 'node-compile-cache',
      ),
    ).toEqual([])
  })

  test('prints the slowest phases as text with --perf', () => {
    const result = doctor(scratch(), ['--perf'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Slowest phases')
    expect(result.stdout).toContain('Time inside the engine, by span')
    expect(result.stdout).toContain('tia.prepare')
  })

  test('exits 1 and says which check failed when a directory is not writable', () => {
    if (process.getuid?.() === 0) return
    const cwd = scratch()
    const locked = join(cwd, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    const result = doctor(cwd, ['--json', '--cache-dir', join(locked, 'cache')])
    chmodSync(locked, 0o755)
    expect(result.status).toBe(1)
    const report: DoctorOutput = JSON.parse(result.stdout)
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.id === 'cache')).toMatchObject({
      detail: expect.stringContaining('is not writable'),
      status: 'fail',
    })
  })

  test('still validates a graph with --graph', () => {
    const cwd = scratch()
    const graph = join(cwd, 'graph.json')
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
    const result = doctor(cwd, ['--graph', graph])
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      protocolVersion: 1,
      suites: 0,
    })
  })
})

describe('crash reports from the CLI', () => {
  test('a defect writes a report and names it in the error', async () => {
    const crashes = scratch()
    vi.stubEnv('TIACORE_CRASH_DIR', crashes)
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new RangeError('cwd exploded')
    })
    const outcome = await execute(['doctor', '--json'])
    vi.restoreAllMocks()
    expect(outcome.code).toBe(1)
    expect(outcome.message).toContain('cwd exploded')
    const [report] = readdirSync(crashes)
    expect(outcome.message).toContain(join(crashes, report ?? ''))
    const body = JSON.parse(readFileSync(join(crashes, report ?? ''), 'utf8'))
    expect(body).toMatchObject({ argv: ['doctor', '--json'] })
    expect(body.cause).toContain('cwd exploded')
    vi.unstubAllEnvs()
  })

  test('an expected failure writes none', async () => {
    const crashes = scratch()
    vi.stubEnv('TIACORE_CRASH_DIR', crashes)
    const outcome = await execute(['doctor', '--graph', join(crashes, 'nope')])
    expect(outcome.code).toBe(1)
    expect(readdirSync(crashes)).toEqual([])
    vi.unstubAllEnvs()
  })
})

/** Starts `tiacore devtools` on a free port and waits until it prints its address. */
async function startDevtools(
  cwd: string,
): Promise<{ child: ChildProcess; output: () => string; port: number }> {
  const child = spawn(
    process.execPath,
    [cli, 'devtools', '--port', '0', '--interval', '100'],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  children.push(child)
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk))
  const deadline = Date.now() + 15_000
  for (;;) {
    const match = /ws:\/\/localhost:(\d+)/u.exec(output)
    if (match !== null) {
      return { child, output: () => output, port: Number(match[1]) }
    }
    if (Date.now() > deadline)
      throw new Error(`devtools did not start: ${output}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('tiacore devtools', () => {
  test('prints spans from a process run with TIACORE_DEVTOOLS and exits 0 on Ctrl-C', async () => {
    const cwd = scratch()
    const server = await startDevtools(cwd)
    const client = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        TIACORE_DEVTOOLS: `ws://localhost:${server.port}`,
      },
    })
    expect(client.status).toBe(0)
    expect(client.stderr).toBe('')
    const deadline = Date.now() + 15_000
    while (!server.output().includes('tia.cli.doctor')) {
      if (Date.now() > deadline) throw new Error(server.output())
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const exited = new Promise<number | null>((resolve) => {
      server.child.once('exit', (code) => resolve(code))
    })
    server.child.kill('SIGINT')
    await expect(exited).resolves.toBe(0)
    const output = server.output()
    expect(output).toContain('Slowest spans')
    expect(output).toContain('Time by span name')
    expect(output).toContain('clients 0/1')
    expect(output).not.toMatch(/\n\s+at /u)
  }, 60_000)

  test('exits 1 with a message when the port is taken', async () => {
    const cwd = scratch()
    const server = await startDevtools(cwd)
    const second = spawnSync(
      process.execPath,
      [cli, 'devtools', '--port', String(server.port)],
      { cwd, encoding: 'utf8' },
    )
    expect(second.status).toBe(1)
    expect(second.stderr).toContain(`cannot listen on localhost:${server.port}`)
  }, 60_000)

  test('rejects a port outside the range', () => {
    const result = spawnSync(
      process.execPath,
      [cli, 'devtools', '--port', '70000'],
      {
        encoding: 'utf8',
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--port must be between 0 and 65535')
  })

  test('a process whose devtools server is absent still finishes and says so', () => {
    const cwd = scratch()
    const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, TIACORE_DEVTOOLS: 'ws://localhost:1' },
    })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('no devtools server at ws://localhost:1')
  })
})
