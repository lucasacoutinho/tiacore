import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ms, versus, type Observation } from '../../support/bench-report.ts'
import {
  bothVersions,
  medianOf,
  spawnTimed,
  type Version,
} from '../../support/bench-run.ts'
import { scaleGraph } from '../../support/scale-graph.ts'
import type { Workload } from './workload.ts'

const bin: Record<Version, string> = {
  current: fileURLToPath(
    new URL('../../../dist/entries/cli.js', import.meta.url),
  ),
  legacy: fileURLToPath(
    new URL(
      '../../../node_modules/tiacore-v1/dist/entries/cli.js',
      import.meta.url,
    ),
  ),
}

interface Files {
  readonly catalog: string
  readonly changes: string
  readonly graph: string
  readonly largeCatalog: string
  readonly largeChanges: string
  readonly largeGraph: string
}

interface Command {
  readonly args: (files: Files) => readonly string[]
  readonly name: string
  /** Processes started per version per round; the round keeps the median. */
  readonly reps: number
}

const plan = (
  catalog: string,
  changes: string,
  graph: string,
  fingerprint: string,
  environment: string,
) => [
  'plan',
  '--catalog',
  catalog,
  '--changes',
  changes,
  '--graph',
  graph,
  '--fingerprint',
  fingerprint,
  '--environment-fingerprint',
  environment,
]

const commands: readonly Command[] = [
  { args: () => ['--version'], name: 'version', reps: 5 },
  {
    args: (files) =>
      plan(files.catalog, files.changes, files.graph, 'project', 'local'),
    name: 'plan-small',
    reps: 5,
  },
  {
    args: (files) =>
      plan(
        files.largeCatalog,
        files.largeChanges,
        files.largeGraph,
        'scale-v1',
        'node20-linux',
      ),
    name: 'plan-25k',
    reps: 3,
  },
]

let directory = ''
let files: Files | undefined

function write(name: string, value: unknown): string {
  const path = join(directory, name)
  writeFileSync(path, JSON.stringify(value))
  return path
}

/**
 * The `tiacore` binary in fresh processes, wall time as a caller waits for it,
 * with node's own start-up (`node-floor`) so the part tiacore adds shows.
 * `plan-small` is the catalog of test/cli/cli.test.ts; `plan-25k` plans a
 * 25,000-suite protocol graph read from a file, which adds JSON parsing and
 * decoding to the planner (the `protocol` workload times those in-process).
 */
export const cli: Workload = {
  name: 'cli',
  round(index) {
    if (files === undefined) throw new Error('cli ran before its setup')
    const inputs = files
    const result: Record<string, Observation> = {
      'node-floor': ms(
        medianOf(5, () => spawnTimed(process.execPath, ['-e', '0']).ms),
      ),
    }
    for (const command of commands) {
      const measured = bothVersions(index, (version) =>
        medianOf(
          command.reps,
          () =>
            spawnTimed(process.execPath, [
              bin[version],
              ...command.args(inputs),
            ]).ms,
        ),
      )
      Object.assign(
        result,
        versus(command.name, measured.current, measured.legacy),
      )
    }
    return result
  },
  setup() {
    directory = mkdtempSync(join(tmpdir(), 'tiacore-bench-cli-'))
    const suites = [
      {
        adapter: 'k6',
        file: 'profiles/smoke.js',
        id: 'k6:smoke',
        project: 'load',
      },
    ]
    const large = scaleGraph(25_000)
    files = {
      catalog: write('catalog.json', suites),
      changes: write('changes.json', ['src/health.ts']),
      graph: write('graph.json', {
        complete: true,
        environmentFingerprint: 'local',
        fingerprint: 'project',
        observations: [
          {
            confidence: 'observed',
            kind: 'route',
            source: 'src/health.ts',
            suiteId: 'k6:smoke',
          },
        ],
        protocolVersion: 1,
        suites,
      }),
      largeCatalog: write('large-catalog.json', large.suites),
      largeChanges: write('large-changes.json', ['src/domain-2718.ts']),
      largeGraph: write('large-graph.json', large),
    }
  },
  summary:
    'tiacore --version, plan on a one-suite catalog and plan on a 25,000-suite graph file, in fresh processes; median of 3-5 processes per version per round',
  teardown() {
    rmSync(directory, { force: true, recursive: true })
  },
  warmup: 1,
}
