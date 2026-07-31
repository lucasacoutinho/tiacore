import type { Command } from 'commander'

import { createImpactPlan, mergeImpactGraphs } from '../protocol/planner.js'
import type { TiaExecutionPolicy } from '../protocol/types.js'
import { parseImpactGraph } from '../protocol/validate.js'
import {
  collect,
  emit,
  parseCatalog,
  parseChanges,
  readJson,
} from './shared.js'

interface OutputOption {
  output?: string
}

export function registerCoreCommands(program: Command): void {
  program
    .command('plan')
    .description('Create a runner-neutral impact plan')
    .requiredOption('--catalog <path>', 'suite catalog JSON')
    .requiredOption('--changes <path>', 'changed paths JSON')
    .option('--graph <path>', 'prior impact graph JSON')
    .requiredOption('--fingerprint <value>', 'current project fingerprint')
    .requiredOption(
      '--environment-fingerprint <value>',
      'current runner environment fingerprint',
    )
    .option('--policy <path>', 'execution policy JSON')
    .option('--force-full', 'force a full plan')
    .option('--output <path>', 'write JSON to a file or -')
    .action(
      async (options: {
        catalog: string
        changes: string
        environmentFingerprint: string
        fingerprint: string
        forceFull?: boolean
        graph?: string
        output?: string
        policy?: string
      }) => {
        const policy =
          options.policy === undefined
            ? {}
            : ((await readJson(options.policy)) as TiaExecutionPolicy)
        if (options.forceFull === true) policy.forceFull = true
        await emit(
          createImpactPlan({
            catalog: parseCatalog(await readJson(options.catalog)),
            changes: parseChanges(await readJson(options.changes)),
            currentEnvironmentFingerprint: options.environmentFingerprint,
            currentFingerprint: options.fingerprint,
            graph:
              options.graph === undefined
                ? null
                : parseImpactGraph(await readJson(options.graph)),
            policy,
          }),
          options.output,
        )
      },
    )

  program
    .command('merge')
    .description('Merge runner-neutral impact graphs')
    .requiredOption(
      '--graph <path>',
      'graph JSON; repeat for every input',
      collect,
      [],
    )
    .option('--output <path>', 'write JSON to a file or -')
    .action(async (options: OutputOption & { graph: string[] }) => {
      const graphs = await Promise.all(
        options.graph.map(async (path) =>
          parseImpactGraph(await readJson(path)),
        ),
      )
      await emit(mergeImpactGraphs(graphs), options.output)
    })

  program
    .command('inspect')
    .description('Summarize a runner-neutral graph')
    .requiredOption('--graph <path>', 'impact graph JSON')
    .option('--output <path>', 'write JSON to a file or -')
    .action(async (options: OutputOption & { graph: string }) => {
      const graph = parseImpactGraph(await readJson(options.graph))
      await emit(
        {
          adapters: [
            ...new Set(graph.suites.map((suite) => suite.adapter)),
          ].sort(),
          complete: graph.complete,
          environmentFingerprint: graph.environmentFingerprint,
          fingerprint: graph.fingerprint,
          observations: graph.observations.length,
          protocolVersion: graph.protocolVersion,
          suites: graph.suites.length,
        },
        options.output,
      )
    })

  program
    .command('doctor')
    .description('Validate a runner-neutral graph')
    .requiredOption('--graph <path>', 'impact graph JSON')
    .option('--output <path>', 'write JSON to a file or -')
    .action(async (options: OutputOption & { graph: string }) => {
      const graph = parseImpactGraph(await readJson(options.graph))
      await emit(
        {
          ok: true,
          protocolVersion: graph.protocolVersion,
          suites: graph.suites.length,
        },
        options.output,
      )
    })
}
