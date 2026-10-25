import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { byCodeUnit } from '../../core/canonical.ts'
import {
  TIA_VERIFICATION_RECEIPT_VERSION,
  type TiaVerificationOptions,
  type TiaVerificationPhase,
  type TiaVerificationReceipt,
  type TiaVerificationSnapshot,
} from '../../core/verification.ts'
import {
  TIA_VERIFICATION_DIRECTORY_ENV,
  TIA_VERIFICATION_PHASE_ENV,
} from '../../engine/verification-snapshot.ts'
import { runPromise } from '../../host/runtime.ts'
import { TiaInvalid, TiaIo } from '../../wire/errors.ts'
import { runProcess } from '../process.ts'
import {
  accuracyReceipt,
  comparePhases,
  performanceReceipt,
  phaseResult,
  type ExecutedPhase,
} from './receipt.ts'
import { readSnapshot } from './snapshot-read.ts'

const asIo = (error: { readonly message: string }) =>
  new TiaIo({ cause: error, message: error.message })

const readSnapshots = Effect.fnUntraced(function* (
  directory: string,
  phase: TiaVerificationPhase,
) {
  const fs = yield* FileSystem.FileSystem
  const root = resolve(directory, phase)
  const entries = yield* fs
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): string[] => []))
  const values: TiaVerificationSnapshot[] = []
  for (const entry of entries.sort(byCodeUnit)) {
    if (!entry.endsWith('.json')) continue
    const text = yield* fs
      .readFileString(resolve(root, entry))
      .pipe(Effect.mapError(asIo))
    const parsed = yield* Effect.try({
      catch: (error) =>
        new TiaInvalid({
          message: error instanceof Error ? error.message : String(error),
        }),
      try: (): unknown => JSON.parse(text),
    })
    const snapshot = readSnapshot(parsed, phase)
    if (snapshot === null) {
      return yield* new TiaInvalid({
        message: `invalid TIA verification snapshot: ${entry}`,
      })
    }
    values.push(snapshot)
  }
  return values
})

const executePhase = Effect.fnUntraced(function* (input: {
  readonly arguments_: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly directory: string
  readonly environment: NodeJS.ProcessEnv
  readonly phase: TiaVerificationPhase
}) {
  const started = performance.now()
  const outcome = yield* runProcess({
    args: input.arguments_,
    command: input.command,
    cwd: input.cwd,
    env: {
      ...input.environment,
      [TIA_VERIFICATION_DIRECTORY_ENV]: input.directory,
      [TIA_VERIFICATION_PHASE_ENV]: input.phase,
      // Only the full phase is fresh; an inherited TIA_FRESH must not turn the
      // selective phase into a second full run.
      TIA_FRESH: input.phase === 'full' ? '1' : undefined,
    },
    stdio: 'inherit',
  })
  const duration = performance.now() - started
  const phase: ExecutedPhase = {
    duration,
    snapshots: yield* readSnapshots(input.directory, input.phase),
    status: outcome.code ?? 128,
  }
  return phase
})

function normalized(options: TiaVerificationOptions): TiaVerificationOptions {
  if (options.command.trim() === '') {
    throw new Error('TIA verification command cannot be empty')
  }
  return options
}

/** Runs the command twice, selective then fresh, and compares the snapshots. */
export const verify = Effect.fn('tia.verify.run')(function* (
  options: TiaVerificationOptions,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cwd = resolve(options.cwd ?? process.cwd())
  const artifactsRoot = options.artifactsDirectory
  const keep = options.keepArtifacts === true || artifactsRoot !== undefined
  if (artifactsRoot !== undefined) {
    yield* fs
      .makeDirectory(resolve(cwd, artifactsRoot), { recursive: true })
      .pipe(Effect.mapError(asIo))
  }
  const directory = yield* fs
    .makeTempDirectory(
      artifactsRoot === undefined
        ? { prefix: 'tiacore-verify-' }
        : { directory: resolve(cwd, artifactsRoot), prefix: 'run-' },
    )
    .pipe(Effect.mapError(asIo))
  const cleanup = keep
    ? Effect.void
    : fs.remove(directory, { force: true, recursive: true }).pipe(Effect.ignore)

  return yield* Effect.gen(function* () {
    const startedAt = new Date()
    const started = performance.now()
    const command = options.command
    const arguments_ = options.arguments ?? []
    const common = {
      arguments_,
      command,
      cwd,
      directory,
      environment: options.environment ?? {},
    }
    const selective = yield* executePhase({ ...common, phase: 'selective' })
    const full = yield* executePhase({ ...common, phase: 'full' })
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
    const receipt: TiaVerificationReceipt = {
      accuracy: accuracyReceipt(comparison.runners),
      command: [command, ...arguments_],
      completedAt: new Date().toISOString(),
      duration: performance.now() - started,
      issues: comparison.issues,
      performance: performanceReceipt(selective, full),
      phases: { full: phaseResult(full), selective: phaseResult(selective) },
      runners: comparison.runners,
      schema: TIA_VERIFICATION_RECEIPT_VERSION,
      startedAt: startedAt.toISOString(),
      success: verified && selective.status === 0 && full.status === 0,
      verified,
    }
    if (options.output !== undefined) {
      const output = resolve(cwd, options.output)
      yield* fs
        .makeDirectory(path.dirname(output), { recursive: true })
        .pipe(Effect.mapError(asIo))
      yield* fs
        .writeFileString(output, `${JSON.stringify(receipt, null, 2)}\n`)
        .pipe(Effect.mapError(asIo))
    }
    return receipt
  }).pipe(Effect.ensuring(cleanup))
})

export class TiaVerifier {
  private readonly options: TiaVerificationOptions

  constructor(options: TiaVerificationOptions) {
    this.options = normalized(options)
  }

  run(): Promise<TiaVerificationReceipt> {
    return runPromise(verify(this.options))
  }
}

export function tia(options: TiaVerificationOptions): TiaVerifier {
  return new TiaVerifier(options)
}
