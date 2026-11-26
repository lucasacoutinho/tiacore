import { arch, platform } from 'node:os'
import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'

import {
  TIA_ADAPTER_CONFORMANCE_VERSION,
  type TiaAdapterCertificationReceipt,
  type TiaAdapterScenarioResult,
  type TiaExecutableCertificationOptions,
  type TiaExecutableScenario,
} from '../../core/conformance.ts'
import { TIA_PROTOCOL_VERSION } from '../../core/protocol.ts'
import {
  inheritedEnvironment,
  type ProcessOutcome,
  runProcess,
} from '../../engine/process.ts'
import { errorMessage, TiaInvalid } from '../../wire/errors.ts'
import { parseAdapterCertificationReceipt } from './parse.ts'

const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 10 * 60 * 1000

const timeoutOf = (scenario: TiaExecutableScenario) => {
  const timeoutMs = scenario.timeoutMs ?? 60_000
  return Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1 &&
    timeoutMs <= MAX_TIMEOUT_MS
    ? Effect.succeed(timeoutMs)
    : Effect.fail(
        new TiaInvalid({
          message: `invalid timeout for certification scenario ${scenario.id}`,
        }),
      )
}

const result = (
  scenario: TiaExecutableScenario,
  durationMs: number,
  passed: boolean,
): TiaAdapterScenarioResult => ({
  evidence: {
    assertions: scenario.assertions ?? 1,
    command: [scenario.command, ...(scenario.arguments ?? [])].join(' '),
    durationMs,
    fixture: scenario.fixture,
  },
  id: scenario.id,
  passed,
})

const LAST_LINE_LENGTH = 160

/** The last non-blank line of `output` on one line, without terminal escapes. */
function lastLine(output: string): string {
  const line =
    output
      .split(/\r?\n/u)
      .map((candidate) =>
        candidate
          // oxlint-disable-next-line no-control-regex -- terminal escapes are control characters
          .replace(/\u001b\[[\d;?]*[a-z]/giu, '')
          // oxlint-disable-next-line no-control-regex -- so are the rest
          .replace(/[\u0000-\u001f\u007f]/gu, ' ')
          .trim(),
      )
      .findLast((candidate) => candidate !== '') ?? ''
  return line.length > LAST_LINE_LENGTH
    ? `${line.slice(0, LAST_LINE_LENGTH - 3)}...`
    : line
}

/** Why a scenario process failed, in a few words and its last output line. */
function diagnosis(outcome: ProcessOutcome, timeoutMs: number): string {
  const reason = outcome.timedOut
    ? `timed out after ${timeoutMs} ms`
    : outcome.overflowed
      ? `wrote more than ${MAX_OUTPUT_BYTES} bytes of output`
      : outcome.code === null
        ? 'ended without an exit code'
        : `exited with code ${outcome.code}`
  const last = lastLine(outcome.output)
  return last === '' ? reason : `${reason}: ${last}`
}

interface Executed {
  /** Why the process failed; absent when it passed. */
  readonly diagnosis?: string
  readonly result: TiaAdapterScenarioResult
}

const execute = Effect.fnUntraced(function* (
  root: string,
  scenario: TiaExecutableScenario,
) {
  const timeoutMs = yield* timeoutOf(scenario)
  const started = performance.now()
  const outcome = yield* runProcess({
    args: scenario.arguments ?? [],
    command: scenario.command,
    cwd: scenario.cwd ? resolve(root, scenario.cwd) : root,
    env: inheritedEnvironment(scenario.environment),
    maxOutputBytes: MAX_OUTPUT_BYTES,
    stdio: 'capture',
    timeoutMs,
  })
  const passed = outcome.code === 0 && !outcome.timedOut && !outcome.overflowed
  const executed: Executed = {
    ...(passed ? {} : { diagnosis: diagnosis(outcome, timeoutMs) }),
    result: result(
      scenario,
      Math.round((performance.now() - started) * 100) / 100,
      passed,
    ),
  }
  return executed
})

/**
 * What a certification run produced: the receipt, and why each failed
 * scenario's process failed. The receipt format is closed, so the reasons
 * travel beside it.
 */
export interface CertificationRun {
  readonly diagnoses: ReadonlyMap<string, string>
  readonly receipt: TiaAdapterCertificationReceipt
}

const receiptOf = (
  options: TiaExecutableCertificationOptions,
  scenarios: TiaAdapterScenarioResult[],
): TiaAdapterCertificationReceipt => ({
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
})

/**
 * Fails when the receipt of `options` could not certify anything, whatever
 * the processes do: an unknown or repeated scenario, a negative assertion
 * count, a level the granularity does not fit. `certify execute` runs it
 * before the first process starts.
 */
export const checkCertification = (
  options: TiaExecutableCertificationOptions,
) =>
  Effect.try({
    catch: (error) => new TiaInvalid({ message: errorMessage(error) }),
    try: () =>
      parseAdapterCertificationReceipt(
        receiptOf(
          options,
          options.scenarios.map((scenario) => result(scenario, 0, false)),
        ),
      ),
  })

/**
 * Runs each scenario's process in order and returns the receipt. A scenario
 * that exits non-zero, times out or floods its output is recorded as failed;
 * a command that cannot start fails the whole run, and an invalid timeout
 * fails it before any process starts.
 */
export const runCertification = Effect.fnUntraced(function* (
  options: TiaExecutableCertificationOptions,
) {
  const root = resolve(options.root ?? process.cwd())
  yield* Effect.forEach(options.scenarios, timeoutOf, { discard: true })
  const executed = yield* Effect.forEach(options.scenarios, (scenario) =>
    execute(root, scenario),
  )
  const run: CertificationRun = {
    diagnoses: new Map(
      executed.flatMap(({ diagnosis: reason, result: { id } }) =>
        reason === undefined ? [] : [[id, reason] as const],
      ),
    ),
    receipt: receiptOf(
      options,
      executed.map(({ result: scenario }) => scenario),
    ),
  }
  return run
})

/** The receipt of `runCertification`, for the public API. */
export const executeCertification = (
  options: TiaExecutableCertificationOptions,
) => runCertification(options).pipe(Effect.map(({ receipt }) => receipt))
