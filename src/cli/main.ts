import * as CliError from 'effect/cli/CliError'
import * as Command from 'effect/cli/Command'
import * as Cause from 'effect/Cause'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'

import { join } from 'node:path'
import { format } from 'node:util'

import { VERSION } from '../core/version.ts'
import { writeCrashReport } from '../host/crash.ts'
import { runExit } from '../host/runtime.ts'
import { artifactsCommand } from './artifacts.ts'
import { certifyCommand } from './certify.ts'
import { devtoolsCommand } from './devtools.ts'
import { doctorCommand } from './doctor.ts'
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
    devtoolsCommand,
    doctorCommand,
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
  /** Help for a usage error, for stderr after `message`, as 1.x printed it. */
  readonly usage?: string
}

/**
 * Effect's CLI prints help, versions and completions through Console; tiacore's
 * own commands write to stdout directly. The Console output is held until the
 * outcome is known: it goes to stdout, or to stderr after a usage error.
 */
function heldConsole(): {
  readonly console: Console.Console
  readonly text: () => string
} {
  const lines: string[] = []
  const console: Console.Console = Object.assign(
    Object.create(globalThis.console),
    {
      log: (...values: ReadonlyArray<unknown>) => {
        lines.push(format(...values))
      },
    },
  )
  return {
    console,
    text: () => (lines.length === 0 ? '' : `${lines.join('\n')}\n`),
  }
}

/**
 * Runs the CLI without printing failures; the caller decides where they go.
 * The command runs on the process-wide host runtime, the one the engine's own
 * `runPromise` calls use, so both report through the same exporters.
 */
export async function execute(argv: readonly string[]): Promise<CliOutcome> {
  // The wizard prompts interactively, so its output cannot wait.
  if (argv.includes('--wizard'))
    return outcomeOf(argv, await runExit(cli(argv)))
  const held = heldConsole()
  const exit = await runExit(
    cli(argv).pipe(Effect.provideService(Console.Console, held.console)),
  )
  const outcome = outcomeOf(argv, exit)
  const text = held.text()
  if (text === '') return outcome
  if (outcome.code !== 0 && outcome.silent !== true) {
    return { ...outcome, usage: text }
  }
  process.stdout.write(text)
  return outcome
}

function outcomeOf(
  argv: readonly string[],
  exit: Exit.Exit<unknown, Effect.Error<ReturnType<typeof cli>>>,
): CliOutcome {
  if (Exit.isSuccess(exit)) return { code: 0 }
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isNone(failure)) {
    if (Cause.hasDies(exit.cause)) {
      const report = writeCrashReport(exit.cause, {
        argv,
        directory:
          process.env['TIACORE_CRASH_DIR'] ??
          join(process.cwd(), '.tia', 'crashes'),
        now: new Date(),
      })
      const where =
        report === undefined ? '' : `\nTIA crash report written to ${report}`
      return { code: 1, message: `${Cause.pretty(exit.cause)}${where}` }
    }
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
