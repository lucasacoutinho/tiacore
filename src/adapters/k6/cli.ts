import type { Command } from 'commander'

import {
  createK6Graph,
  discoverK6Suites,
  planK6,
  type K6GraphOptions,
} from './index.js'
import { collect, emit, parseChanges, readJson } from '../../cli/shared.js'
import { parseImpactGraph } from '../../protocol/validate.js'

interface K6RootOptions {
  profiles: string
  project: string
  root: string
}

function rootOptions(options: K6RootOptions): {
  project: string
  root: string
} {
  return { project: options.project, root: options.root }
}

function base(command: Command): Command {
  return command
    .requiredOption('--root <directory>', 'repository root')
    .requiredOption('--profiles <directory>', 'k6 profile directory')
    .requiredOption('--project <name>', 'suite project name')
    .option('--output <path>', 'write JSON to a file or -')
}

export function registerK6Commands(program: Command): void {
  const k6 = program.command('k6').description('k6 adapter commands')

  base(k6.command('discover').description('Discover k6 profiles')).action(
    async (options: K6RootOptions & { output?: string }) => {
      await emit(
        await discoverK6Suites({
          ...rootOptions(options),
          profiles: options.profiles,
        }),
        options.output,
      )
    },
  )

  base(k6.command('record').description('Record a k6 impact graph'))
    .requiredOption(
      '--environment-fingerprint <value>',
      'runner environment fingerprint',
    )
    .option('--fingerprint <value>', 'project fingerprint')
    .option('--graph-options <path>', 'graph options JSON')
    .action(
      async (
        options: K6RootOptions & {
          environmentFingerprint: string
          fingerprint?: string
          graphOptions?: string
          output?: string
        },
      ) => {
        const suites = await discoverK6Suites({
          ...rootOptions(options),
          profiles: options.profiles,
        })
        const graphOptions =
          options.graphOptions === undefined
            ? {}
            : ((await readJson(
                options.graphOptions,
              )) as Partial<K6GraphOptions>)
        await emit(
          await createK6Graph(options.root, {
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

  base(k6.command('plan').description('Plan affected k6 profiles'))
    .requiredOption('--changes <path>', 'changed paths JSON')
    .requiredOption(
      '--environment-fingerprint <value>',
      'runner environment fingerprint',
    )
    .option('--fingerprint <value>', 'project fingerprint')
    .option('--graph <path>', 'prior k6 impact graph')
    .option('--force-full', 'force every profile')
    .option('--ignore-unknown', 'ignore unknown changed paths')
    .option(
      '--ignore-change <glob>',
      'ignored changed path; repeat as needed',
      collect,
      [],
    )
    .option(
      '--allowed-profile <id>',
      'allowed profile ID; repeat as needed',
      collect,
      [],
    )
    .action(
      async (
        options: K6RootOptions & {
          allowedProfile: string[]
          changes: string
          environmentFingerprint: string
          fingerprint?: string
          forceFull?: boolean
          graph?: string
          ignoreChange: string[]
          ignoreUnknown?: boolean
          output?: string
        },
      ) => {
        await emit(
          await planK6({
            ...rootOptions(options),
            ...(options.allowedProfile.length === 0
              ? {}
              : { allowedProfiles: options.allowedProfile }),
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
            profiles: options.profiles,
          }),
          options.output,
        )
      },
    )
}
