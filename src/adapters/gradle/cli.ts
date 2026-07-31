import type { Command } from 'commander'

import { collect, emit, parseChanges, readJson } from '../../cli/shared.js'
import { parseImpactGraph } from '../../protocol/validate.js'
import { discoverGradleSuites, planGradle } from './index.js'

interface Options {
  environmentFingerprint: string
  output?: string
  project: string
  root: string
  source: string[]
  test: string[]
}

function base(command: Command): Command {
  return command
    .requiredOption('--root <directory>', 'repository root')
    .requiredOption('--project <name>', 'Gradle project name')
    .option('--test <glob>', 'test source glob; repeat as needed', collect, [])
    .option(
      '--source <glob>',
      'production source glob; repeat as needed',
      collect,
      [],
    )
    .option('--output <path>', 'write JSON to a file or -')
}

function discovery(options: Options) {
  return {
    project: options.project,
    root: options.root,
    ...(options.source.length === 0 ? {} : { sources: options.source }),
    ...(options.test.length === 0 ? {} : { tests: options.test }),
  }
}

export function registerGradleCommands(program: Command): void {
  const gradle = program
    .command('gradle')
    .description('Gradle/JUnit adapter commands')
  base(
    gradle
      .command('discover')
      .description('Discover Gradle JUnit test classes'),
  ).action(async (options: Options) =>
    emit(await discoverGradleSuites(discovery(options)), options.output),
  )
  base(
    gradle
      .command('plan')
      .description('Plan affected Gradle JUnit test classes'),
  )
    .requiredOption('--changes <path>', 'changed paths JSON')
    .requiredOption(
      '--environment-fingerprint <value>',
      'runner environment fingerprint',
    )
    .option('--fingerprint <value>', 'project fingerprint')
    .option('--graph <path>', 'prior Gradle impact graph')
    .option('--force-full', 'force every test class')
    .option(
      '--ignore-change <glob>',
      'ignored changed path; repeat as needed',
      collect,
      [],
    )
    .option('--ignore-unknown', 'ignore unknown changed paths')
    .action(
      async (
        options: Options & {
          changes: string
          fingerprint?: string
          forceFull?: boolean
          graph?: string
          ignoreChange: string[]
          ignoreUnknown?: boolean
        },
      ) =>
        emit(
          await planGradle({
            ...discovery(options),
            changes: parseChanges(await readJson(options.changes)).files,
            currentEnvironmentFingerprint: options.environmentFingerprint,
            ...(options.fingerprint
              ? { currentFingerprint: options.fingerprint }
              : {}),
            forceFull: options.forceFull === true,
            graph: options.graph
              ? parseImpactGraph(await readJson(options.graph))
              : null,
            ignoreChanges: options.ignoreChange,
            onUnknownChange: options.ignoreUnknown ? 'ignore' : 'full',
          }),
          options.output,
        ),
    )
}
