// Measures tiacore against the published 1.x and prints numbers. It asserts
// nothing: it is the tool for performance work, `npm run check:perf` is the
// gate. Run it as `npm run bench -- [options]`; see CONTRIBUTING.md.
// The import is for its effect: it clears TIA_* settings and stops background
// repository maintenance in every process the benchmark starts.
// oxlint-disable-next-line import/no-unassigned-import
import '../support/hermetic-env.ts'

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import { VERSION } from '../../src/core/version.ts'
import {
  collect,
  parseRun,
  renderComparison,
  renderRun,
  type BenchMeta,
  type BenchRecord,
  type RoundResult,
  type WorkloadRecord,
} from '../support/bench-report.ts'
import { workloads } from './bench/index.ts'
import type { Workload } from './bench/workload.ts'

const DEFAULT_ROUNDS = 7

const USAGE = `Usage: npm run bench -- [options]

  -n, --rounds <count>  rounds per workload (default ${DEFAULT_ROUNDS})
      --only <names>    run only these workloads (comma separated or repeated)
      --save <file>     write the raw samples to <file> (use .bench/<name>.json)
      --compare <file>  compare with a saved run and flag wins and losses
      --list            list the workloads and exit
  -h, --help            show this help
`

const { values } = parseArgs({
  options: {
    compare: { type: 'string' },
    help: { short: 'h', type: 'boolean' },
    list: { type: 'boolean' },
    only: { multiple: true, type: 'string' },
    rounds: { short: 'n', type: 'string' },
    save: { type: 'string' },
  },
  strict: true,
})

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  return process.exit(2)
}

if (values.help === true) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (values.list === true) {
  for (const workload of workloads) {
    process.stdout.write(`${workload.name.padEnd(16)}${workload.summary}\n`)
  }
  process.exit(0)
}

const rounds =
  values.rounds === undefined ? DEFAULT_ROUNDS : Number(values.rounds)
if (!Number.isInteger(rounds) || rounds < 1) {
  fail(`--rounds must be a positive integer, not ${values.rounds}`)
}

const requested = (values.only ?? []).flatMap((names) =>
  names.split(',').filter((name) => name !== ''),
)
const unknown = requested.filter(
  (name) => !workloads.some((workload) => workload.name === name),
)
if (unknown.length > 0) {
  fail(
    `unknown workload ${unknown.join(', ')}; the workloads are ${workloads.map((workload) => workload.name).join(', ')}`,
  )
}
const selected = workloads.filter(
  (workload) => requested.length === 0 || requested.includes(workload.name),
)

// Read the saved run now: a wrong path should not cost a full run.
let saved: BenchRecord | undefined
if (values.compare !== undefined) {
  try {
    saved = parseRun(readFileSync(values.compare, 'utf8'))
  } catch (error) {
    fail(`cannot read ${values.compare}: ${String(error)}`)
  }
}
if (values.save !== undefined) {
  mkdirSync(dirname(values.save), { recursive: true })
}

function progress(text: string): void {
  process.stderr.write(text)
}

async function measure(workload: Workload): Promise<WorkloadRecord> {
  const started = performance.now()
  progress(`${workload.name} `)
  await workload.setup?.()
  try {
    const observed: RoundResult[] = []
    for (let index = 0; index < workload.warmup + rounds; index += 1) {
      // A collection pending from the previous round would land in this one.
      globalThis.gc?.()
      const result = await workload.round(index)
      if (index < workload.warmup) {
        progress('w')
      } else {
        observed.push(result)
        progress('.')
      }
    }
    const seconds = (performance.now() - started) / 1000
    progress(` ${seconds.toFixed(1)} s\n`)
    return { metrics: collect(observed), rounds, seconds }
  } finally {
    await workload.teardown?.()
  }
}

function git(args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}

function legacyVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL('../../node_modules/tiacore-v1/package.json', import.meta.url),
      'utf8',
    ),
  )
  return typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
    ? manifest.version
    : 'unknown'
}

const results: Record<string, WorkloadRecord> = {}
const failures: string[] = []
for (const workload of selected) {
  try {
    results[workload.name] = await measure(workload)
  } catch (error) {
    progress(' failed\n')
    failures.push(
      `${workload.name}: ${String(error instanceof Error ? error.stack : error)}`,
    )
  }
}

const meta: BenchMeta = {
  arch: process.arch,
  commit: git(['rev-parse', '--short', 'HEAD']),
  cpus: cpus().length,
  createdAt: new Date().toISOString(),
  dirty: (git(['status', '--porcelain']) ?? '') !== '',
  legacyVersion: legacyVersion(),
  node: process.version,
  platform: process.platform,
  rounds,
  version: VERSION,
}
const run: BenchRecord = { meta, schema: 1, workloads: results }

process.stdout.write(`\n${renderRun(run)}\n`)
if (values.save !== undefined) {
  writeFileSync(values.save, `${JSON.stringify(run, null, 1)}\n`)
  process.stdout.write(`\nsaved ${values.save}\n`)
}
if (saved !== undefined) {
  process.stdout.write(`\n${renderComparison(saved, run).text}\n`)
}
for (const failure of failures) process.stderr.write(`\n${failure}\n`)
process.exit(failures.length === 0 ? 0 : 1)
