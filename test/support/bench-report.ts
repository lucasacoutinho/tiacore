import * as Schema from 'effect/Schema'

import { exactMedian, mad, minimum } from './stats.ts'

// Measurements, summaries and the comparison rule of `npm run bench`
// (test/perf/bench.ts). Every metric is a cost: smaller is better.

const UnitSchema = Schema.Literals(['count', 'ms', 'ms/test', 'x'])
export type Unit = typeof UnitSchema.Type

export interface Observation {
  readonly unit: Unit
  readonly value: number
}

/** What one round of a workload measured, by metric name. */
export type RoundResult = Readonly<Record<string, Observation>>

export const ms = (value: number): Observation => ({ unit: 'ms', value })
export const perTest = (value: number): Observation => ({
  unit: 'ms/test',
  value,
})
export const count = (value: number): Observation => ({ unit: 'count', value })
/** A 2.0 over 1.x ratio, or any other quotient of two measurements. */
export const ratio = (value: number): Observation => ({ unit: 'x', value })

/**
 * One quantity measured for both versions, as three metrics: `name` (2.0),
 * `name.v1` (1.x) and `name.ratio` (2.0 over 1.x of the same round).
 */
export function versus(
  name: string,
  current: number,
  legacy: number,
  observe: (value: number) => Observation = ms,
): RoundResult {
  return {
    [name]: observe(current),
    [`${name}.v1`]: observe(legacy),
    [`${name}.ratio`]: ratio(current / legacy),
  }
}

// A saved run is user input (a file chosen with --compare), so it is decoded.
const MetricSchema = Schema.Struct({
  /** One value per round, in round order, as measured (never rounded). */
  samples: Schema.Array(Schema.Finite),
  unit: UnitSchema,
})
const WorkloadSchema = Schema.Struct({
  metrics: Schema.Record(Schema.String, MetricSchema),
  rounds: Schema.Int,
  /** Wall-clock seconds the workload took, setup and warm-up included. */
  seconds: Schema.Finite,
})
const MetaSchema = Schema.Struct({
  arch: Schema.String,
  commit: Schema.NullOr(Schema.String),
  cpus: Schema.Int,
  createdAt: Schema.String,
  dirty: Schema.Boolean,
  legacyVersion: Schema.String,
  node: Schema.String,
  platform: Schema.String,
  rounds: Schema.Int,
  version: Schema.String,
})
const RunSchema = Schema.Struct({
  meta: MetaSchema,
  schema: Schema.Literal(1),
  workloads: Schema.Record(Schema.String, WorkloadSchema),
})

export type MetricRecord = typeof MetricSchema.Type
export type WorkloadRecord = typeof WorkloadSchema.Type
export type BenchMeta = typeof MetaSchema.Type
export type BenchRecord = typeof RunSchema.Type

export interface Summary {
  readonly mad: number
  readonly median: number
  readonly min: number
}

export function summarize(samples: readonly number[]): Summary {
  return {
    mad: mad(samples),
    median: exactMedian(samples),
    min: minimum(samples),
  }
}

/** Folds the rounds of one workload into one record per metric. */
export function collect(
  rounds: readonly RoundResult[],
): Record<string, MetricRecord> {
  const samples = new Map<string, number[]>()
  const units = new Map<string, Unit>()
  for (const round of rounds) {
    for (const [name, observation] of Object.entries(round)) {
      if (!Number.isFinite(observation.value)) {
        throw new Error(`metric ${name} measured ${observation.value}`)
      }
      const known = units.get(name)
      if (known !== undefined && known !== observation.unit) {
        throw new Error(`metric ${name} changed unit from ${known}`)
      }
      units.set(name, observation.unit)
      const values = samples.get(name) ?? []
      values.push(observation.value)
      samples.set(name, values)
    }
  }
  const metrics: Record<string, MetricRecord> = {}
  for (const [name, values] of samples) {
    metrics[name] = { samples: values, unit: units.get(name) ?? 'ms' }
  }
  return metrics
}

/**
 * A change is a win or a loss only when it is larger than twice the combined
 * noise of the two runs: |delta of medians| > 2 * (MAD of one + MAD of the
 * other). Anything smaller is indistinguishable from run-to-run variation.
 */
export const NOISE_FACTOR = 2

export type Verdict = 'loss' | 'noise' | 'win'

export interface Comparison {
  readonly baseMedian: number
  readonly delta: number
  readonly nextMedian: number
  /** The largest change that still counts as noise. */
  readonly noise: number
  readonly percent: number
  readonly verdict: Verdict
}

export function compareSamples(
  base: readonly number[],
  next: readonly number[],
): Comparison {
  const before = summarize(base)
  const after = summarize(next)
  const delta = after.median - before.median
  const noise = NOISE_FACTOR * (before.mad + after.mad)
  return {
    baseMedian: before.median,
    delta,
    nextMedian: after.median,
    noise,
    percent: before.median === 0 ? Number.NaN : (delta / before.median) * 100,
    verdict: delta < -noise ? 'win' : delta > noise ? 'loss' : 'noise',
  }
}

function digits(value: number, unit: Unit): number {
  if (unit === 'count') return Number.isInteger(value) ? 0 : 1
  if (unit === 'x') return 3
  const size = Math.abs(value)
  return size >= 1000 ? 0 : size >= 100 ? 1 : 2
}

export function format(value: number, unit: Unit): string {
  return Number.isNaN(value) ? 'n/a' : value.toFixed(digits(value, unit))
}

function signed(value: number, unit: Unit): string {
  const text = format(value, unit)
  return value > 0 ? `+${text}` : text
}

function percentText(value: number): string {
  if (Number.isNaN(value)) return 'n/a'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  indent = '  ',
): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]) =>
    indent +
    cells
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column] ?? 0)
          : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

export function renderWorkload(name: string, record: WorkloadRecord): string {
  const rows = Object.entries(record.metrics).map(([metric, data]) => {
    const summary = summarize(data.samples)
    const noise =
      summary.median === 0
        ? 'n/a'
        : `${((summary.mad / summary.median) * 100).toFixed(1)}%`
    return [
      metric,
      data.unit,
      format(summary.median, data.unit),
      format(summary.min, data.unit),
      format(summary.mad, data.unit),
      noise,
    ]
  })
  return [
    `${name}  (${record.rounds} rounds, ${record.seconds.toFixed(1)} s)`,
    table(['metric', 'unit', 'median', 'min', 'MAD', 'MAD/median'], rows),
  ].join('\n')
}

export function renderRun(run: BenchRecord): string {
  const { meta } = run
  const head = [
    `tiacore ${meta.version} against 1.x ${meta.legacyVersion}; ratio = 2.0 / 1.x, below 1 means 2.0 is faster`,
    `node ${meta.node}, ${meta.platform}/${meta.arch}, ${meta.cpus} cpus, commit ${meta.commit ?? 'unknown'}${meta.dirty ? ' (dirty)' : ''}, ${meta.rounds} rounds`,
  ]
  return [
    head.join('\n'),
    ...Object.entries(run.workloads).map(([name, record]) =>
      renderWorkload(name, record),
    ),
  ].join('\n\n')
}

export interface ComparisonTally {
  readonly losses: number
  readonly wins: number
}

export function renderComparison(
  base: BenchRecord,
  next: BenchRecord,
): { readonly tally: ComparisonTally; readonly text: string } {
  const sections: string[] = []
  let wins = 0
  let losses = 0
  const missing: string[] = []
  for (const [name, record] of Object.entries(next.workloads)) {
    const before = base.workloads[name]
    if (before === undefined) {
      missing.push(`${name}: not in the saved run`)
      continue
    }
    const rows: string[][] = []
    let workloadWins = 0
    let workloadLosses = 0
    for (const [metric, data] of Object.entries(record.metrics)) {
      const saved = before.metrics[metric]
      if (saved === undefined) {
        missing.push(`${name}/${metric}: not in the saved run`)
        continue
      }
      const result = compareSamples(saved.samples, data.samples)
      if (result.verdict === 'win') workloadWins += 1
      if (result.verdict === 'loss') workloadLosses += 1
      rows.push([
        metric,
        data.unit,
        format(result.baseMedian, data.unit),
        format(result.nextMedian, data.unit),
        signed(result.delta, data.unit),
        percentText(result.percent),
        format(result.noise, data.unit),
        result.verdict === 'noise' ? '' : result.verdict.toUpperCase(),
      ])
    }
    for (const metric of Object.keys(before.metrics)) {
      if (record.metrics[metric] === undefined) {
        missing.push(`${name}/${metric}: not in this run`)
      }
    }
    wins += workloadWins
    losses += workloadLosses
    sections.push(
      [
        `${name}  (${workloadWins} wins, ${workloadLosses} losses)`,
        table(
          ['metric', 'unit', 'saved', 'now', 'delta', '%', 'noise limit', ''],
          rows,
        ),
      ].join('\n'),
    )
  }
  const head = `against ${base.meta.createdAt} (commit ${base.meta.commit ?? 'unknown'}${base.meta.dirty ? ', dirty' : ''}, ${base.meta.rounds} rounds); a change counts only beyond ${NOISE_FACTOR} x (MAD saved + MAD now)`
  const tail = [
    `${wins} wins, ${losses} losses`,
    ...(missing.length > 0
      ? ['not compared:', ...missing.map((line) => `  ${line}`)]
      : []),
  ].join('\n')
  return {
    tally: { losses, wins },
    text: [head, ...sections, tail].join('\n\n'),
  }
}

const decodeRun = Schema.decodeUnknownSync(RunSchema)

/** Reads a saved run; throws when the text is not one. */
export function parseRun(text: string): BenchRecord {
  return decodeRun(JSON.parse(text))
}
