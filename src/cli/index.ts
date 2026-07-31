import { readFileSync } from 'node:fs'

import { Command, CommanderError } from 'commander'

import { registerK6Commands } from '../adapters/k6/cli.js'
import { registerGradleCommands } from '../adapters/gradle/cli.js'
import { registerMaestroCommands } from '../adapters/maestro/cli.js'
import { registerConformanceCommands } from '../conformance/cli.js'
import { registerArtifactCommands } from '../engine/artifacts/cli.js'
import { registerWorkspaceCommand } from '../orchestration/workspace/cli.js'
import { registerVerificationCommand } from '../verification/cli.js'
import { registerCoreCommands } from './core.js'

export function createCli(): Command {
  const packageMetadata = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  const program = new Command()
    .name('tiacore')
    .description('Test impact analysis for heterogeneous test suites')
    .version(packageMetadata.version)
    .enablePositionalOptions()
    .showHelpAfterError()
    .exitOverride()

  registerCoreCommands(program)
  registerConformanceCommands(program)
  registerArtifactCommands(program)
  registerWorkspaceCommand(program)
  registerVerificationCommand(program)
  registerGradleCommands(program)
  registerK6Commands(program)
  registerMaestroCommands(program)
  return program
}

export async function runCli(arguments_: readonly string[]): Promise<void> {
  let errorOutput = ''
  const program = createCli().configureOutput({
    writeErr: (value) => {
      errorOutput += value
    },
    writeOut: (value) => process.stdout.write(value),
  })
  try {
    await program.parseAsync(['node', 'tiacore', ...arguments_])
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.exitCode === 0
    ) {
      return
    }
    if (error instanceof CommanderError) {
      throw new Error(errorOutput.trim() || error.message)
    }
    throw error
  }
}
