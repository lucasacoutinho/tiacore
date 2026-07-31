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
  signingKeyEnv: string
  signingKeyId: string
  trustExpiresIn?: string
}

function artifactCommand(
  command: Command,
  promoted: boolean,
): void {
  command
    .requiredOption('--artifact-id <id>', 'artifact identifier')
    .requiredOption('--run-id <id>', 'producing run identifier')
    .requiredOption('--signing-key-id <id>', 'trusted signing key identifier')
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
    .option(
      '--signing-key-env <name>',
      'environment variable containing an Ed25519 private key in PEM format',
      'TIA_ARTIFACT_PRIVATE_KEY',
    )
    .option(
      '--trust-expires-in <seconds>',
      'attestation lifetime in seconds',
      '604800',
    )
    .action(async (options: ArtifactOptions) => {
      const privateKey = process.env[options.signingKeyEnv]
      if (privateKey === undefined || privateKey.trim() === '') {
        throw new Error(
          `TIA artifact signing key is missing from ${options.signingKeyEnv}`,
        )
      }
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
        signing: {
          expiresInSeconds: Number(options.trustExpiresIn),
          keyId: options.signingKeyId,
          privateKey,
        },
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
