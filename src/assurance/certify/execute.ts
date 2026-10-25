import { arch, platform } from 'node:os'
import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'

import {
  TIA_ADAPTER_CONFORMANCE_VERSION,
  type TiaAdapterCapabilityLevel,
  type TiaAdapterCertificationReceipt,
  type TiaAdapterFeature,
  type TiaAdapterScenarioResult,
} from '../../core/conformance.ts'
import { TIA_PROTOCOL_VERSION } from '../../core/protocol.ts'
import { runPromise } from '../../host/runtime.ts'
import { TiaInvalid } from '../../wire/errors.ts'
import { runProcess } from '../process.ts'

const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 10 * 60 * 1000

export interface TiaExecutableScenario {
  arguments?: string[]
  assertions?: number
  command: string
  cwd?: string
  environment?: Record<string, string>
  fixture: string
  id: string
  timeoutMs?: number
}

export interface TiaExecutableCertificationOptions {
  adapter: string
  capabilityLevel: TiaAdapterCapabilityLevel
  features?: TiaAdapterFeature[]
  root?: string
  runner: { name: string; version: string }
  scenarios: TiaExecutableScenario[]
  selectionGranularity: TiaAdapterCertificationReceipt['selectionGranularity']
  sourceRevision: string
}

const execute = Effect.fnUntraced(function* (
  root: string,
  scenario: TiaExecutableScenario,
) {
  const timeoutMs = scenario.timeoutMs ?? 60_000
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return yield* new TiaInvalid({
      message: `invalid timeout for certification scenario ${scenario.id}`,
    })
  }
  const started = performance.now()
  const outcome = yield* runProcess({
    args: scenario.arguments ?? [],
    command: scenario.command,
    cwd: scenario.cwd ? resolve(root, scenario.cwd) : root,
    env: scenario.environment,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    stdio: 'capture',
    timeoutMs,
  })
  const result: TiaAdapterScenarioResult = {
    evidence: {
      assertions: scenario.assertions ?? 1,
      command: [scenario.command, ...(scenario.arguments ?? [])].join(' '),
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      fixture: scenario.fixture,
    },
    id: scenario.id,
    passed: outcome.code === 0 && !outcome.timedOut && !outcome.overflowed,
  }
  return result
})

/**
 * Runs each scenario's process in order and returns the receipt. A scenario
 * that exits non-zero, times out or floods its output is recorded as failed;
 * a command that cannot start fails the whole run.
 */
export const executeCertification = Effect.fnUntraced(function* (
  options: TiaExecutableCertificationOptions,
) {
  const root = resolve(options.root ?? process.cwd())
  const scenarios = yield* Effect.forEach(options.scenarios, (scenario) =>
    execute(root, scenario),
  )
  const receipt: TiaAdapterCertificationReceipt = {
    adapter: options.adapter,
    capabilityLevel: options.capabilityLevel,
    contractVersion: TIA_ADAPTER_CONFORMANCE_VERSION,
    environment: { architecture: arch(), operatingSystem: platform() },
    features: options.features ?? [],
    generatedAt: new Date().toISOString(),
    protocolVersion: TIA_PROTOCOL_VERSION,
    runner: options.runner,
    scenarios,
    selectionGranularity: options.selectionGranularity,
    sourceRevision: options.sourceRevision,
  }
  return receipt
})

export function executeAdapterCertification(
  options: TiaExecutableCertificationOptions,
): Promise<TiaAdapterCertificationReceipt> {
  return runPromise(executeCertification(options))
}
