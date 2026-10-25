import * as NodeServices from '@effect/platform-node/NodeServices'
import * as CliError from 'effect/cli/CliError'
import * as Command from 'effect/cli/Command'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'

import { VERSION } from '../core/version.ts'
import { artifactsCommand } from './artifacts.ts'
import { certifyCommand } from './certify.ts'
import { gradleCommand } from './gradle.ts'
import { k6Command } from './k6.ts'
import { maestroCommand } from './maestro.ts'
import { protocolCommands } from './protocol.ts'
import { runCommand } from './run.ts'
import { verifyCommand } from './verify.ts'

const root = Command.make('tiacore').pipe(
  Command.withDescription('Test impact analysis for heterogeneous test suites'),
  Command.withSubcommands([
    ...protocolCommands,
    artifactsCommand,
    certifyCommand,
    gradleCommand,
    k6Command,
    maestroCommand,
    runCommand,
    verifyCommand,
  ]),
)

export const cli = Command.runWith(root, {
  renderErrors: false,
  version: VERSION,
})

export interface CliOutcome {
  readonly code: number
  /** What went wrong, for stderr; absent on success and on requested help. */
  readonly message?: string
  /** The failure was already reported, for example in a written receipt. */
  readonly silent?: boolean
}

/** Runs the CLI without printing failures; the caller decides where they go. */
export async function execute(argv: readonly string[]): Promise<CliOutcome> {
  const exit = await Effect.runPromiseExit(
    cli(argv).pipe(Effect.provide(NodeServices.layer)),
  )
  if (Exit.isSuccess(exit)) return { code: 0 }
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure)) {
    return { code: 1, message: Cause.pretty(exit.cause) }
  }
  const error = failure.value
  if (CliError.isCliError(error) && error._tag === 'ShowHelp') {
    const asked = argv.includes('--help') || argv.includes('-h')
    if (error.errors.length === 0) return asked ? { code: 0 } : { code: 1 }
    return {
      code: 1,
      message: error.errors.map((problem) => problem.message).join('\n'),
    }
  }
  if (error._tag === 'TiaFailed' && error.silent === true)
    return { code: 1, silent: true }
  return { code: 1, message: error.message }
}

/** The 1.x programmatic entry: resolves on success and throws the failure message. */
export async function runCli(argv: readonly string[]): Promise<void> {
  const outcome = await execute(argv)
  if (outcome.silent === true) {
    process.exitCode = outcome.code
    return
  }
  if (outcome.code !== 0) {
    throw new Error(
      outcome.message ?? `tiacore exited with code ${outcome.code}`,
    )
  }
}
