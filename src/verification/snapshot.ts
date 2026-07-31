import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { replayRunEvent } from '../engine/replay/index.js'
import type { RunPlan, TiaRuntimeGraph } from '../engine/types.js'
import {
  TIA_VERIFICATION_SNAPSHOT_VERSION,
  type TiaVerificationPhase,
  type TiaVerificationSnapshot,
} from './types.js'

export const TIA_VERIFICATION_DIRECTORY_ENV = 'TIA_VERIFICATION_DIRECTORY'
export const TIA_VERIFICATION_PHASE_ENV = 'TIA_VERIFICATION_PHASE'

function verificationPhase(value: string): TiaVerificationPhase {
  if (value === 'selective' || value === 'full') return value
  throw new Error(`${TIA_VERIFICATION_PHASE_ENV} must be selective or full`)
}

function snapshotName(runner: string, fingerprint: string): string {
  return createHash('sha256')
    .update(runner)
    .update('\0')
    .update(fingerprint)
    .digest('hex')
}

export async function writeVerificationSnapshot(input: {
  executedTestIds: Iterable<string>
  graph: TiaRuntimeGraph
  plan: RunPlan
  runner: string
  success: boolean
}): Promise<void> {
  const directory = process.env[TIA_VERIFICATION_DIRECTORY_ENV]
  const phaseValue = process.env[TIA_VERIFICATION_PHASE_ENV]
  if (directory === undefined && phaseValue === undefined) return
  if (directory === undefined || phaseValue === undefined) {
    throw new Error(
      `${TIA_VERIFICATION_DIRECTORY_ENV} and ${TIA_VERIFICATION_PHASE_ENV} must be set together`,
    )
  }

  const phase = verificationPhase(phaseValue)
  const phaseDirectory = resolve(directory, phase)
  await mkdir(phaseDirectory, { recursive: true })
  const target = resolve(
    phaseDirectory,
    `${snapshotName(input.runner, input.graph.fingerprint)}.json`,
  )
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const executedTestIds = [...new Set(input.executedTestIds)]
    .filter((id) => input.graph.results[id]?.state !== 'skipped')
    .sort()
  const snapshot: TiaVerificationSnapshot = {
    executedTestIds,
    generatedAt: new Date().toISOString(),
    graph: structuredClone(input.graph),
    phase,
    plan: replayRunEvent(input.plan),
    runner: input.runner,
    schema: TIA_VERIFICATION_SNAPSHOT_VERSION,
    success: input.success,
  }
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8')
  await rename(temporary, target)
}
