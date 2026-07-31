import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

import { compareVerificationSnapshots } from './compare.js'
import {
  TIA_VERIFICATION_DIRECTORY_ENV,
  TIA_VERIFICATION_PHASE_ENV,
} from './snapshot.js'
import {
  TIA_VERIFICATION_RECEIPT_VERSION,
  TIA_VERIFICATION_SNAPSHOT_VERSION,
  type TiaVerificationIssue,
  type TiaVerificationAccuracy,
  type TiaVerificationOptions,
  type TiaVerificationPhase,
  type TiaVerificationPhaseResult,
  type TiaVerificationPerformance,
  type TiaVerificationReceipt,
  type TiaVerificationRunnerResult,
  type TiaVerificationSnapshot,
} from './types.js'

interface ExecutedPhase {
  duration: number
  snapshots: TiaVerificationSnapshot[]
  status: number
}

function validSnapshot(
  value: unknown,
  phase: TiaVerificationPhase,
): value is TiaVerificationSnapshot {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<TiaVerificationSnapshot>
  return (
    candidate.schema === TIA_VERIFICATION_SNAPSHOT_VERSION &&
    candidate.phase === phase &&
    typeof candidate.runner === 'string' &&
    candidate.runner !== '' &&
    candidate.graph !== null &&
    typeof candidate.graph === 'object' &&
    candidate.plan !== null &&
    typeof candidate.plan === 'object'
  )
}

async function snapshots(
  directory: string,
  phase: TiaVerificationPhase,
): Promise<TiaVerificationSnapshot[]> {
  const root = resolve(directory, phase)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const values: TiaVerificationSnapshot[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const value = JSON.parse(
      await readFile(resolve(root, entry), 'utf8'),
    ) as unknown
    if (!validSnapshot(value, phase)) {
      throw new Error(`invalid TIA verification snapshot: ${basename(entry)}`)
    }
    values.push(value)
  }
  return values
}

async function childStatus(
  command: string,
  arguments_: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((resolveStatus, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveStatus(code ?? (signal === null ? 1 : 128))
    })
  })
}

async function executePhase(input: {
  arguments_: string[]
  command: string
  cwd: string
  directory: string
  environment: NodeJS.ProcessEnv
  phase: TiaVerificationPhase
}): Promise<ExecutedPhase> {
  const started = performance.now()
  const environment = {
    ...process.env,
    ...input.environment,
    [TIA_VERIFICATION_DIRECTORY_ENV]: input.directory,
    [TIA_VERIFICATION_PHASE_ENV]: input.phase,
    ...(input.phase === 'full' ? { TIA_FRESH: '1' } : {}),
  }
  const status = await childStatus(
    input.command,
    input.arguments_,
    input.cwd,
    environment,
  )
  return {
    duration: performance.now() - started,
    snapshots: await snapshots(input.directory, input.phase),
    status,
  }
}

function indexedSnapshots(
  values: TiaVerificationSnapshot[],
  issues: TiaVerificationIssue[],
): Map<string, TiaVerificationSnapshot> {
  const indexed = new Map<string, TiaVerificationSnapshot>()
  for (const snapshot of values) {
    if (indexed.has(snapshot.runner)) {
      issues.push({
        code: 'duplicate-snapshot',
        message: `phase produced more than one snapshot for ${snapshot.runner}`,
        runner: snapshot.runner,
      })
      continue
    }
    indexed.set(snapshot.runner, snapshot)
  }
  return indexed
}

function comparePhases(
  selective: TiaVerificationSnapshot[],
  full: TiaVerificationSnapshot[],
): { issues: TiaVerificationIssue[]; runners: TiaVerificationRunnerResult[] } {
  const issues: TiaVerificationIssue[] = []
  const selectiveByRunner = indexedSnapshots(selective, issues)
  const fullByRunner = indexedSnapshots(full, issues)
  const runnerNames = [
    ...new Set([...selectiveByRunner.keys(), ...fullByRunner.keys()]),
  ].sort()
  const runners: TiaVerificationRunnerResult[] = []

  for (const runner of runnerNames) {
    const selectiveSnapshot = selectiveByRunner.get(runner)
    const fullSnapshot = fullByRunner.get(runner)
    if (selectiveSnapshot === undefined) {
      const missing: TiaVerificationIssue = {
        code: 'missing-selective-snapshot',
        message: `selective phase did not produce a snapshot for ${runner}`,
        runner,
      }
      issues.push(missing)
      runners.push({
        issues: [missing],
        runner,
        selection: null,
        verified: false,
      })
      continue
    }
    if (fullSnapshot === undefined) {
      const missing: TiaVerificationIssue = {
        code: 'missing-full-snapshot',
        message: `full phase did not produce a snapshot for ${runner}`,
        runner,
      }
      issues.push(missing)
      runners.push({
        issues: [missing],
        runner,
        selection: null,
        verified: false,
      })
      continue
    }
    const result = compareVerificationSnapshots(selectiveSnapshot, fullSnapshot)
    issues.push(...result.issues)
    runners.push(result)
  }

  if (runnerNames.length === 0) {
    issues.push({
      code: 'snapshot-invalid',
      message: 'verification command did not produce any TIA snapshots',
    })
  }
  return { issues, runners }
}

function accuracyReceipt(
  runners: TiaVerificationRunnerResult[],
): TiaVerificationAccuracy {
  const selections = runners.flatMap((runner) =>
    runner.selection === null ? [] : [runner.selection],
  )
  const executedTests = selections.reduce(
    (sum, selection) => sum + selection.executedTestIds.length,
    0,
  )
  const expectedTests = selections.reduce(
    (sum, selection) => sum + selection.expectedTestIds.length,
    0,
  )
  const missedTests = selections.reduce(
    (sum, selection) => sum + selection.missedTestIds.length,
    0,
  )
  const unnecessaryTests = selections.reduce(
    (sum, selection) => sum + selection.unnecessaryTestIds.length,
    0,
  )
  const relevantExecutedTests = executedTests - unnecessaryTests

  return {
    executedTests,
    expectedTests,
    falseNegativeRate: expectedTests === 0 ? 0 : missedTests / expectedTests,
    missedTests,
    precision:
      executedTests === 0 ? null : relevantExecutedTests / executedTests,
    unnecessaryTests,
  }
}

function phaseResult(phase: ExecutedPhase): TiaVerificationPhaseResult {
  return {
    duration: phase.duration,
    metrics: phase.snapshots.map((snapshot) => ({
      executedTests: snapshot.executedTestIds.length,
      mode: snapshot.plan.mode,
      reason: snapshot.plan.reason,
      replayedTests: snapshot.plan.replayedTests,
      runner: snapshot.runner,
    })),
    runners: phase.snapshots.map((snapshot) => snapshot.runner).sort(),
    status: phase.status,
  }
}

function total(
  phaseSnapshots: TiaVerificationSnapshot[],
  value: (snapshot: TiaVerificationSnapshot) => number,
): number {
  return phaseSnapshots.reduce((sum, snapshot) => sum + value(snapshot), 0)
}

function performanceReceipt(
  selective: ExecutedPhase,
  full: ExecutedPhase,
): TiaVerificationPerformance {
  const selectiveExecutedTests = total(
    selective.snapshots,
    (snapshot) => snapshot.executedTestIds.length,
  )
  const fullExecutedTests = total(
    full.snapshots,
    (snapshot) => snapshot.executedTestIds.length,
  )
  return {
    durationSaved: full.duration - selective.duration,
    executionReduction:
      fullExecutedTests === 0
        ? null
        : 1 - selectiveExecutedTests / fullExecutedTests,
    fallbacks: selective.snapshots.flatMap((snapshot) =>
      snapshot.plan.mode === 'record'
        ? [{ reason: snapshot.plan.reason, runner: snapshot.runner }]
        : [],
    ),
    fullExecutedTests,
    selectiveExecutedTests,
    selectiveReplayedTests: total(
      selective.snapshots,
      (snapshot) => snapshot.plan.replayedTests,
    ),
    speedup:
      selective.duration === 0 ? null : full.duration / selective.duration,
  }
}

export class TiaVerifier {
  private readonly options: TiaVerificationOptions

  constructor(options: TiaVerificationOptions) {
    if (options.command.trim() === '') {
      throw new Error('TIA verification command cannot be empty')
    }
    this.options = options
  }

  async run(): Promise<TiaVerificationReceipt> {
    const cwd = resolve(this.options.cwd ?? process.cwd())
    const artifactsRoot = this.options.artifactsDirectory
    if (artifactsRoot !== undefined) {
      await mkdir(resolve(cwd, artifactsRoot), { recursive: true })
    }
    const directory = await mkdtemp(
      artifactsRoot === undefined
        ? resolve(tmpdir(), 'tiacore-verify-')
        : resolve(cwd, artifactsRoot, 'run-'),
    )
    const startedAt = new Date()
    const started = performance.now()

    try {
      const command = this.options.command
      const arguments_ = this.options.arguments ?? []
      const common = {
        arguments_,
        command,
        cwd,
        directory,
        environment: this.options.environment ?? {},
      }
      const selective = await executePhase({
        ...common,
        phase: 'selective',
      })
      const full = await executePhase({ ...common, phase: 'full' })
      const comparison = comparePhases(selective.snapshots, full.snapshots)
      if (selective.status !== 0) {
        comparison.issues.push({
          code: 'selective-run-failed',
          message: `selective command exited with status ${selective.status}`,
        })
      }
      if (full.status !== 0) {
        comparison.issues.push({
          code: 'full-run-failed',
          message: `full command exited with status ${full.status}`,
        })
      }
      const verified =
        comparison.runners.length > 0 &&
        comparison.runners.every((runner) => runner.verified) &&
        !comparison.issues.some(
          (item) =>
            item.code !== 'selective-run-failed' &&
            item.code !== 'full-run-failed',
        )
      const completedAt = new Date()
      const receipt: TiaVerificationReceipt = {
        accuracy: accuracyReceipt(comparison.runners),
        command: [command, ...arguments_],
        completedAt: completedAt.toISOString(),
        duration: performance.now() - started,
        issues: comparison.issues,
        performance: performanceReceipt(selective, full),
        phases: {
          full: phaseResult(full),
          selective: phaseResult(selective),
        },
        runners: comparison.runners,
        schema: TIA_VERIFICATION_RECEIPT_VERSION,
        startedAt: startedAt.toISOString(),
        success: verified && selective.status === 0 && full.status === 0,
        verified,
      }
      if (this.options.output !== undefined) {
        const output = resolve(cwd, this.options.output)
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
      }
      return receipt
    } finally {
      if (
        this.options.keepArtifacts !== true &&
        this.options.artifactsDirectory === undefined
      ) {
        await rm(directory, { force: true, recursive: true })
      }
    }
  }
}

export function tia(options: TiaVerificationOptions): TiaVerifier {
  return new TiaVerifier(options)
}
