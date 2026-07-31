import type { Command } from 'commander'

import { runWorkspaceCommand } from './config.js'

export function registerWorkspaceCommand(program: Command): void {
  program
    .command('run')
    .description('Run configured workspace lanes')
    .option('--config <path>', 'workspace config module', 'tiacore.config.mjs')
    .option('--output <path>', 'write the workspace receipt')
    .action(async (options: { config: string; output?: string }) => {
      await runWorkspaceCommand({
        config: options.config,
        ...(options.output === undefined
          ? {}
          : { output: options.output }),
      })
    })
}
