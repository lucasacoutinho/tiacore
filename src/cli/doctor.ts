import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import { VERSION } from '../core/version.ts'
import { formatDuration } from '../host/span-render.ts'
import { TiaFailed } from '../wire/errors.ts'
import { output, outputPath, readGraph } from './adapters.ts'
import {
  type CheckStatus,
  type DoctorCheck,
  selfCheck,
} from './doctor-checks.ts'
import type { PerfReport } from './doctor-perf.ts'
import { emitJson } from './io.ts'

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[]
  readonly ok: boolean
  readonly perf?: PerfReport
  readonly tiacore: string
}

type PerfOutcome =
  | { readonly perf: PerfReport }
  | { readonly skipped: DoctorCheck }
  | Record<string, never>

const MARKS: Readonly<Record<CheckStatus, string>> = {
  fail: 'FAIL',
  info: 'info',
  ok: 'ok',
  warn: 'warn',
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

/** The report as plain text for a terminal. */
export function renderDoctor(report: DoctorReport): string {
  const lines = [`tiacore doctor ${report.tiacore}`, '']
  const width = Math.max(...report.checks.map((check) => check.title.length))
  for (const check of report.checks) {
    lines.push(
      `${pad(MARKS[check.status], 5)} ${pad(check.title, width)}  ${check.detail}`,
    )
  }
  const perf = report.perf
  if (perf !== undefined) {
    lines.push(
      '',
      `Performance on a throwaway project (${perf.project.testFiles} test files)`,
    )
    lines.push('', '  Slowest phases')
    for (const phase of perf.phases) {
      lines.push(
        `  ${padStart(formatDuration(phase.milliseconds), 10)}  ${phase.name}`,
      )
    }
    if (perf.spans.length > 0) {
      lines.push('', '  Time inside the engine, by span')
      lines.push(
        `  ${pad('span', 28)} ${padStart('count', 5)} ${padStart('total', 10)} ${padStart('max', 10)}`,
      )
      for (const span of perf.spans) {
        lines.push(
          `  ${pad(span.name, 28)} ${padStart(String(span.count), 5)} ${padStart(formatDuration(span.totalMilliseconds), 10)} ${padStart(formatDuration(span.maxMilliseconds), 10)}`,
        )
      }
    }
  }
  lines.push(
    '',
    report.ok
      ? 'No problems found.'
      : 'Problems found. Fix the lines marked FAIL.',
  )
  return `${lines.join('\n')}\n`
}

const flags = {
  cacheDir: Flag.String('cache-dir').pipe(
    Flag.withDescription('cache directory to check'),
    Flag.withDefault('.tia'),
  ),
  graph: Flag.String('graph').pipe(
    Flag.withDescription('validate this impact graph instead of the install'),
    Flag.optional,
  ),
  json: Flag.Boolean('json').pipe(
    Flag.withDescription('print JSON instead of text'),
    Flag.withDefault(false),
  ),
  output,
  perf: Flag.Boolean('perf').pipe(
    Flag.withDescription('also time prepare and commit on a throwaway project'),
    Flag.withDefault(false),
  ),
}

export const doctorCommand = Command.make(
  'doctor',
  flags,
  Effect.fn('tia.cli.doctor')(function* (options) {
    if (Option.isSome(options.graph)) {
      const graph = yield* readGraph(options.graph.value)
      yield* emitJson(
        {
          ok: true,
          protocolVersion: graph.protocolVersion,
          suites: graph.suites.length,
        },
        outputPath(options.output),
      )
      return
    }
    const checks = yield* selfCheck({
      cacheDir: options.cacheDir,
      cwd: process.cwd(),
      env: process.env,
      nodeVersion: process.version,
    })
    const measured: PerfOutcome = options.perf
      ? yield* Effect.promise(() => import('./doctor-perf.ts')).pipe(
          Effect.flatMap((module) => module.measurePerformance()),
          Effect.scoped,
          Effect.map((perf): PerfOutcome => ({ perf })),
          Effect.catchTag('TiaIo', (error) =>
            Effect.succeed<PerfOutcome>({
              skipped: {
                detail: `skipped: ${error.message}`,
                id: 'perf',
                status: 'warn',
                title: 'Performance',
              },
            }),
          ),
        )
      : {}
    const report: DoctorReport = {
      checks: 'skipped' in measured ? [...checks, measured.skipped] : checks,
      ok: checks.every((check) => check.status !== 'fail'),
      ...('perf' in measured ? { perf: measured.perf } : {}),
      tiacore: VERSION,
    }
    const path = outputPath(options.output)
    if (options.json || path !== undefined) {
      yield* emitJson(report, path)
    } else {
      process.stdout.write(renderDoctor(report))
    }
    if (!report.ok) {
      return yield* new TiaFailed({
        message: 'tiacore doctor found problems',
        silent: true,
      })
    }
  }),
).pipe(
  Command.withDescription(
    'Check the install, or validate a runner-neutral graph with --graph',
  ),
)
