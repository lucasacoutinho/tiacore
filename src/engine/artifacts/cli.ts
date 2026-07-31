import type { Command } from 'commander'

import { collect, emit } from '../../cli/shared.js'
import { tia } from './publish.js'

interface ArtifactOptions {
  artifactId: string
  baseUrl?: string
  cacheDir: string
  group?: string
  outputDir: string
  parent: string[]
  producer?: string
  receipt?: string
  requireCoverage?: boolean
  root?: string
  runId: string
  runner?: string
}

function artifactCommand(
  command: Command,
  promoted: boolean,
): void {
  command
    .requiredOption('--artifact-id <id>', 'artifact identifier')
    .requiredOption('--run-id <id>', 'producing run identifier')
    .option('--cache-dir <directory>', 'graph cache directory', '.tia')
    .option('--output-dir <directory>', 'artifact output directory', '.tia-artifacts')
    .option('--base-url <url>', 'public base URL for output files')
    .option('--group <id>', 'partition group identifier')
    .option(
      '--parent <id>',
      'parent artifact ID; repeat as needed',
      collect,
      [],
    )
    .option('--producer <name>', 'producing system name')
    .option('--receipt <path>', 'write the publication receipt to a file or -')
    .option('--require-coverage', 'require complete coverage for promotion')
    .option('--root <directory>', 'repository root')
    .option('--runner <name>', 'runner namespace in the archive')
    .action(async (options: ArtifactOptions) => {
      const publisher = tia({
        artifactId: options.artifactId,
        cacheDir: options.cacheDir,
        filesystem: {
          ...(options.baseUrl === undefined
            ? {}
            : { baseUrl: options.baseUrl }),
          directory: options.outputDir,
        },
        ...(options.group === undefined ? {} : { group: options.group }),
        parents: options.parent,
        ...(options.producer === undefined
          ? {}
          : { producer: options.producer }),
        requireCoverage: options.requireCoverage === true,
        ...(options.root === undefined ? {} : { root: options.root }),
        runId: options.runId,
        ...(options.runner === undefined
          ? {}
          : { runner: options.runner }),
      })
      await emit(
        promoted
          ? await publisher.promote()
          : await publisher.publish(),
        options.receipt,
      )
    })
}

export function registerArtifactCommands(program: Command): void {
  const artifacts = program
    .command('artifacts')
    .description('Publish provider-neutral graph artifacts')
  artifactCommand(
    artifacts.command('publish').description('Publish a graph or partition'),
    false,
  )
  artifactCommand(
    artifacts.command('promote').description('Promote a complete graph'),
    true,
  )
}
