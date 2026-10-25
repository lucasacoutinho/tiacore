import { createHash, randomUUID } from 'node:crypto'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import type { RunPlan, TiaRuntimeGraph } from '../core/runtime.ts'
import {
  TIA_VERIFICATION_SNAPSHOT_VERSION,
  type TiaVerificationPhase,
  type TiaVerificationSnapshot,
} from '../core/verification.ts'
import { TiaInvalid, TiaIo } from '../wire/errors.ts'
import { replayRunEvent } from './replay.ts'

export const TIA_VERIFICATION_DIRECTORY_ENV = 'TIA_VERIFICATION_DIRECTORY'
export const TIA_VERIFICATION_PHASE_ENV = 'TIA_VERIFICATION_PHASE'

const RECORD_DOMAINS = new Set([
  'collectionCoverage',
  'collectionFiles',
  'coverageMaps',
  'edges',
  'results',
  'testCoverage',
  'testEdges',
])

/** Where `tiacore verify` collects this run's snapshot, and for which phase. */
export interface VerificationTarget {
  readonly directory: string
  readonly phase: TiaVerificationPhase
}

export interface VerificationSnapshotInput {
  readonly executedTestIds: Iterable<string>
  readonly graph: TiaRuntimeGraph
  readonly plan: RunPlan
  readonly runner: string
  readonly success: boolean
  /** Undefined when no `tiacore verify` drives this process: nothing is written. */
  readonly target: VerificationTarget | undefined
}

function snapshotName(runner: string, fingerprint: string): string {
  return createHash('sha256')
    .update(runner)
    .update('\0')
    .update(fingerprint)
    .digest('hex')
}

/** The graph as JSON chunks, one record at a time, so no chunk holds the whole graph. */
function* graphChunks(graph: TiaRuntimeGraph): Generator<string> {
  const entries = Object.entries(graph).filter(
    ([, value]) => value !== undefined,
  )
  yield '{'
  for (const [index, [key, value]] of entries.entries()) {
    yield `${index === 0 ? '' : ','}${JSON.stringify(key)}:`
    if (!RECORD_DOMAINS.has(key)) {
      yield JSON.stringify(value)
      continue
    }
    yield '{'
    let first = true
    for (const [id, record] of Object.entries(
      value as Record<string, unknown>,
    )) {
      yield `${first ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(record)}`
      first = false
    }
    yield '}'
  }
  yield '}'
}

const asIo = (error: { readonly message: string }) =>
  new TiaIo({ cause: error, message: error.message })

/**
 * The verification target `tiacore verify` sets up through
 * TIA_VERIFICATION_DIRECTORY and TIA_VERIFICATION_PHASE, or undefined when
 * neither is set. A run reads it before it starts, so a misconfiguration fails
 * the run instead of leaving a saved graph behind a rejected commit.
 */
export const verificationTarget = Effect.fnUntraced(function* (
  env: Readonly<Record<string, string | undefined>>,
) {
  const directory = env[TIA_VERIFICATION_DIRECTORY_ENV]
  const phase = env[TIA_VERIFICATION_PHASE_ENV]
  if (directory === undefined && phase === undefined) return undefined
  if (directory === undefined || phase === undefined) {
    return yield* new TiaInvalid({
      message: `${TIA_VERIFICATION_DIRECTORY_ENV} and ${TIA_VERIFICATION_PHASE_ENV} must be set together`,
    })
  }
  if (phase !== 'selective' && phase !== 'full') {
    return yield* new TiaInvalid({
      message: `${TIA_VERIFICATION_PHASE_ENV} must be selective or full`,
    })
  }
  return { directory, phase } satisfies VerificationTarget
})

/**
 * Writes the run's verification snapshot to `target`, if there is one. The
 * file is written beside its destination and renamed into place, so a reader
 * never sees a partial snapshot.
 */
export const writeVerificationSnapshot = Effect.fnUntraced(function* (
  input: VerificationSnapshotInput,
) {
  if (input.target === undefined) return
  const { directory, phase } = input.target
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const phaseDirectory = path.resolve(directory, phase)
  yield* fs
    .makeDirectory(phaseDirectory, { recursive: true })
    .pipe(Effect.mapError(asIo))
  const target = path.resolve(
    phaseDirectory,
    `${snapshotName(input.runner, input.graph.fingerprint)}.json`,
  )
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const executedTestIds = [...new Set(input.executedTestIds)]
    .filter((id) => input.graph.results[id]?.state !== 'skipped')
    .sort()
  const { graph, ...envelope } = {
    executedTestIds,
    generatedAt: new Date().toISOString(),
    graph: input.graph,
    phase,
    plan: replayRunEvent(input.plan),
    runner: input.runner,
    schema: TIA_VERIFICATION_SNAPSHOT_VERSION,
    success: input.success,
  } satisfies TiaVerificationSnapshot

  const encoder = new TextEncoder()
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(temporary, { flag: 'w' })
      const write = (chunk: string) => file.writeAll(encoder.encode(chunk))
      const head = JSON.stringify(envelope)
      yield* write(`${head.slice(0, -1)},"graph":`)
      for (const chunk of graphChunks(graph)) yield* write(chunk)
      yield* write('}\n')
    }),
  ).pipe(Effect.mapError(asIo))
  yield* fs.rename(temporary, target).pipe(Effect.mapError(asIo))
})
