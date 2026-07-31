import type { Command } from 'commander'

import { TiaVerifier } from './runner.js'

export function registerVerificationCommand(program: Command): void {
  program
    .command('verify')
    .description('Compare selective and fresh full results')
    .option('--output <path>', 'write the verification receipt')
    .option('--cwd <directory>', 'test command working directory')
    .option('--artifacts <directory>', 'retain phase snapshots')
    .argument('<command...>', 'test command and its arguments')
    .passThroughOptions()
    .allowUnknownOption(true)
    .action(
      async (
        command: string[],
        options: {
          artifacts?: string
          cwd?: string
          output?: string
        },
      ) => {
        const [executable, ...arguments_] = command
        if (executable === undefined) {
          throw new Error('verify requires a test command')
        }
        const receipt = await new TiaVerifier({
          arguments: arguments_,
          ...(options.artifacts === undefined
            ? {}
            : {
                artifactsDirectory: options.artifacts,
                keepArtifacts: true,
              }),
          command: executable,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.output === undefined ? {} : { output: options.output }),
        }).run()
        if (options.output === undefined) {
          process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
        }
        if (!receipt.success) process.exitCode = 1
      },
    )
}
