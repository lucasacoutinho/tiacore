import type { Command } from 'commander'

import {
  createMaestroGraph,
  discoverMaestroSuites,
  planMaestro,
  type MaestroGraphOptions,
} from './index.js'
import { collect, emit, parseChanges, readJson } from '../../cli/shared.js'
import { parseImpactGraph } from '../../protocol/validate.js'

interface MaestroRootOptions {
  excludeTag: string[]
  flows: string
  includeTag: string[]
  output?: string
  project: string
  root: string
}

function rootOptions(options: MaestroRootOptions): {
  project: string
  root: string
} {
  return { project: options.project, root: options.root }
}

function base(command: Command): Command {
  return command
    .requiredOption('--root <directory>', 'repository root')
    .requiredOption('--flows <directory>', 'Maestro flow directory')
    .requiredOption('--project <name>', 'suite project name')
    .option(
      '--include-tag <tag>',
      'included flow tag; repeat as needed',
      collect,
      [],
    )
    .option(
      '--exclude-tag <tag>',
      'excluded flow tag; repeat as needed',
      collect,
      [],
    )
    .option('--output <path>', 'write JSON to a file or -')
}

function discoveryOptions(options: MaestroRootOptions) {
  return {
    ...rootOptions(options),
    excludeTags: options.excludeTag,
    flows: options.flows,
    includeTags: options.includeTag,
  }
}

export function registerMaestroCommands(program: Command): void {
  const maestro = program
    .command('maestro')
    .description('Maestro adapter commands')

  base(
    maestro.command('discover').description('Discover Maestro flows'),
  ).action(async (options: MaestroRootOptions) => {
    await emit(
      await discoverMaestroSuites(discoveryOptions(options)),
      options.output,
    )
  })

  base(maestro.command('record').description('Record a Maestro impact graph'))
    .requiredOption(
      '--environment-fingerprint <value>',
      'runner environment fingerprint',
    )
    .option('--fingerprint <value>', 'project fingerprint')
    .option('--graph-options <path>', 'graph options JSON')
    .action(
      async (
        options: MaestroRootOptions & {
          environmentFingerprint: string
          fingerprint?: string
          graphOptions?: string
        },
      ) => {
        const suites = await discoverMaestroSuites(discoveryOptions(options))
        const graphOptions =
          options.graphOptions === undefined
            ? {}
            : ((await readJson(
                options.graphOptions,
              )) as Partial<MaestroGraphOptions>)
        await emit(
          createMaestroGraph({
            environmentFingerprint: options.environmentFingerprint,
            ...(options.fingerprint === undefined
              ? {}
              : { fingerprint: options.fingerprint }),
            invalidators: graphOptions.invalidators ?? [],
            knownSources: graphOptions.knownSources ?? [],
            observations: graphOptions.observations ?? [],
            suites,
          }),
          options.output,
        )
      },
    )

  base(maestro.command('plan').description('Plan affected Maestro flows'))
    .requiredOption('--changes <path>', 'changed paths JSON')
    .requiredOption(
      '--environment-fingerprint <value>',
      'runner environment fingerprint',
    )
    .option('--fingerprint <value>', 'project fingerprint')
    .option('--graph <path>', 'prior Maestro impact graph')
    .option('--force-full', 'force every flow')
    .option('--ignore-unknown', 'ignore unknown changed paths')
    .option(
      '--ignore-change <glob>',
      'ignored changed path; repeat as needed',
      collect,
      [],
    )
    .action(
      async (
        options: MaestroRootOptions & {
          changes: string
          environmentFingerprint: string
          fingerprint?: string
          forceFull?: boolean
          graph?: string
          ignoreChange: string[]
          ignoreUnknown?: boolean
        },
      ) => {
        await emit(
          await planMaestro({
            ...discoveryOptions(options),
            changes: parseChanges(await readJson(options.changes)).files,
            currentEnvironmentFingerprint: options.environmentFingerprint,
            ...(options.fingerprint === undefined
              ? {}
              : { currentFingerprint: options.fingerprint }),
            forceFull: options.forceFull === true,
            graph:
              options.graph === undefined
                ? null
                : parseImpactGraph(await readJson(options.graph)),
            ignoreChanges: options.ignoreChange,
            onUnknownChange: options.ignoreUnknown === true ? 'ignore' : 'full',
          }),
          options.output,
        )
      },
    )
}
