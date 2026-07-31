import { readFile, writeFile } from 'node:fs/promises'

import {
  createK6Graph,
  discoverK6Suites,
  planK6,
  type K6GraphOptions,
} from '../adapters/k6/index.js'
import {
  createMaestroGraph,
  discoverMaestroSuites,
  planMaestro,
  type MaestroGraphOptions,
} from '../adapters/maestro/index.js'
import { certifyAdapterReceipt } from '../conformance/certification.js'
import { createImpactPlan, mergeImpactGraphs } from '../protocol/planner.js'
import type {
  TiaChangeSet,
  TiaExecutionPolicy,
  TiaSuiteDescriptor,
} from '../protocol/types.js'
import { parseImpactGraph } from '../protocol/validate.js'
import {
  option,
  parseArguments,
  repeated,
  type ParsedArguments,
} from './arguments.js'
import { runWorkspaceCommand } from './workspace.js'

function usage(): string {
  return [
    'Usage:',
    '  tiacore plan --catalog suites.json [--graph graph.json] --changes changes.json',
    '    --fingerprint VALUE --environment-fingerprint VALUE [--policy policy.json]',
    '  tiacore merge --graph graph-a.json --graph graph-b.json --output graph.json',
    '  tiacore inspect --graph graph.json',
    '  tiacore doctor --graph graph.json',
    '  tiacore certify adapter --receipt receipt.json',
    '  tiacore run --config tiacore.config.mjs [--output result.json]',
    '  tiacore maestro discover|record|plan --root DIR --flows DIR --project NAME',
    '  tiacore k6 discover|record|plan --root DIR --profiles DIR --project NAME',
    '',
  ].join('\n')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function emit(value: unknown, output: string | undefined): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (output === undefined || output === '-') {
    process.stdout.write(serialized)
    return
  }
  await writeFile(output, serialized, 'utf8')
}

function parseCatalog(value: unknown): TiaSuiteDescriptor[] {
  if (!Array.isArray(value)) {
    throw new Error('TIA suite catalog must be an array')
  }
  return value as TiaSuiteDescriptor[]
}

function parseChanges(value: unknown): TiaChangeSet {
  if (Array.isArray(value) && value.every((file) => typeof file === 'string')) {
    return { files: value }
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { files?: unknown }).files) &&
    (value as { files: unknown[] }).files.every(
      (file) => typeof file === 'string',
    )
  ) {
    return value as TiaChangeSet
  }
  throw new Error('TIA change set must be a string array or an object with files')
}

async function plan(parsed: ParsedArguments): Promise<void> {
  const catalogPath = option(parsed, 'catalog', true)!
  const changesPath = option(parsed, 'changes', true)!
  const graphPath = option(parsed, 'graph')
  const policyPath = option(parsed, 'policy')
  const currentFingerprint = option(parsed, 'fingerprint', true)!
  const currentEnvironmentFingerprint = option(
    parsed,
    'environment-fingerprint',
    true,
  )!
  const policy =
    policyPath === undefined
      ? {}
      : ((await readJson(policyPath)) as TiaExecutionPolicy)
  if (parsed.flags.has('force-full')) {
    policy.forceFull = true
  }

  await emit(
    createImpactPlan({
      catalog: parseCatalog(await readJson(catalogPath)),
      changes: parseChanges(await readJson(changesPath)),
      currentEnvironmentFingerprint,
      currentFingerprint,
      graph:
        graphPath === undefined
          ? null
          : parseImpactGraph(await readJson(graphPath)),
      policy,
    }),
    option(parsed, 'output'),
  )
}

async function merge(parsed: ParsedArguments): Promise<void> {
  const paths = parsed.options.get('graph') ?? []
  if (paths.length === 0) {
    throw new Error('merge requires at least one --graph')
  }
  const graphs = await Promise.all(
    paths.map(async (path) => parseImpactGraph(await readJson(path))),
  )
  await emit(mergeImpactGraphs(graphs), option(parsed, 'output'))
}

async function inspect(parsed: ParsedArguments): Promise<void> {
  const graph = parseImpactGraph(await readJson(option(parsed, 'graph', true)!))
  const adapters = [...new Set(graph.suites.map((suite) => suite.adapter))].sort()
  await emit(
    {
      adapters,
      complete: graph.complete,
      environmentFingerprint: graph.environmentFingerprint,
      fingerprint: graph.fingerprint,
      observations: graph.observations.length,
      protocolVersion: graph.protocolVersion,
      suites: graph.suites.length,
    },
    option(parsed, 'output'),
  )
}

async function doctor(parsed: ParsedArguments): Promise<void> {
  const graph = parseImpactGraph(await readJson(option(parsed, 'graph', true)!))
  await emit(
    {
      ok: true,
      protocolVersion: graph.protocolVersion,
      suites: graph.suites.length,
    },
    option(parsed, 'output'),
  )
}

async function certifyAdapter(parsed: ParsedArguments): Promise<void> {
  await emit(
    certifyAdapterReceipt(
      await readJson(option(parsed, 'receipt', true)!),
    ),
    option(parsed, 'output'),
  )
}

function adapterRootOptions(parsed: ParsedArguments): {
  project: string
  root: string
} {
  return {
    project: option(parsed, 'project', true)!,
    root: option(parsed, 'root', true)!,
  }
}

async function maestroDiscover(parsed: ParsedArguments): Promise<void> {
  await emit(
    await discoverMaestroSuites({
      ...adapterRootOptions(parsed),
      excludeTags: repeated(parsed, 'exclude-tag'),
      flows: option(parsed, 'flows', true)!,
      includeTags: repeated(parsed, 'include-tag'),
    }),
    option(parsed, 'output'),
  )
}

async function maestroRecord(parsed: ParsedArguments): Promise<void> {
  const suites = await discoverMaestroSuites({
    ...adapterRootOptions(parsed),
    excludeTags: repeated(parsed, 'exclude-tag'),
    flows: option(parsed, 'flows', true)!,
    includeTags: repeated(parsed, 'include-tag'),
  })
  const graphOptionsPath = option(parsed, 'graph-options')
  const graphOptions =
    graphOptionsPath === undefined
      ? {}
      : ((await readJson(graphOptionsPath)) as Partial<MaestroGraphOptions>)
  const fingerprint = option(parsed, 'fingerprint')
  await emit(
    createMaestroGraph({
      environmentFingerprint: option(
        parsed,
        'environment-fingerprint',
        true,
      )!,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      invalidators: graphOptions.invalidators ?? [],
      knownSources: graphOptions.knownSources ?? [],
      observations: graphOptions.observations ?? [],
      suites,
    }),
    option(parsed, 'output'),
  )
}

async function maestroPlan(parsed: ParsedArguments): Promise<void> {
  const graphPath = option(parsed, 'graph')
  const currentFingerprint = option(parsed, 'fingerprint')
  await emit(
    await planMaestro({
      ...adapterRootOptions(parsed),
      changes: parseChanges(
        await readJson(option(parsed, 'changes', true)!),
      ).files,
      currentEnvironmentFingerprint: option(
        parsed,
        'environment-fingerprint',
        true,
      )!,
      ...(currentFingerprint === undefined ? {} : { currentFingerprint }),
      excludeTags: repeated(parsed, 'exclude-tag'),
      flows: option(parsed, 'flows', true)!,
      forceFull: parsed.flags.has('force-full'),
      graph:
        graphPath === undefined
          ? null
          : parseImpactGraph(await readJson(graphPath)),
      ignoreChanges: repeated(parsed, 'ignore-change'),
      includeTags: repeated(parsed, 'include-tag'),
      onUnknownChange: parsed.flags.has('ignore-unknown') ? 'ignore' : 'full',
    }),
    option(parsed, 'output'),
  )
}

async function k6Discover(parsed: ParsedArguments): Promise<void> {
  await emit(
    await discoverK6Suites({
      ...adapterRootOptions(parsed),
      profiles: option(parsed, 'profiles', true)!,
    }),
    option(parsed, 'output'),
  )
}

async function k6Record(parsed: ParsedArguments): Promise<void> {
  const rootOptions = adapterRootOptions(parsed)
  const suites = await discoverK6Suites({
    ...rootOptions,
    profiles: option(parsed, 'profiles', true)!,
  })
  const graphOptionsPath = option(parsed, 'graph-options')
  const graphOptions =
    graphOptionsPath === undefined
      ? {}
      : ((await readJson(graphOptionsPath)) as Partial<K6GraphOptions>)
  const fingerprint = option(parsed, 'fingerprint')
  await emit(
    await createK6Graph(rootOptions.root, {
      environmentFingerprint: option(
        parsed,
        'environment-fingerprint',
        true,
      )!,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      invalidators: graphOptions.invalidators ?? [],
      knownSources: graphOptions.knownSources ?? [],
      observations: graphOptions.observations ?? [],
      suites,
    }),
    option(parsed, 'output'),
  )
}

async function k6Plan(parsed: ParsedArguments): Promise<void> {
  const graphPath = option(parsed, 'graph')
  const allowedProfiles = repeated(parsed, 'allowed-profile')
  const currentFingerprint = option(parsed, 'fingerprint')
  await emit(
    await planK6({
      ...adapterRootOptions(parsed),
      ...(allowedProfiles.length === 0 ? {} : { allowedProfiles }),
      changes: parseChanges(
        await readJson(option(parsed, 'changes', true)!),
      ).files,
      currentEnvironmentFingerprint: option(
        parsed,
        'environment-fingerprint',
        true,
      )!,
      ...(currentFingerprint === undefined ? {} : { currentFingerprint }),
      forceFull: parsed.flags.has('force-full'),
      graph:
        graphPath === undefined
          ? null
          : parseImpactGraph(await readJson(graphPath)),
      ignoreChanges: repeated(parsed, 'ignore-change'),
      onUnknownChange: parsed.flags.has('ignore-unknown') ? 'ignore' : 'full',
      profiles: option(parsed, 'profiles', true)!,
    }),
    option(parsed, 'output'),
  )
}

export async function runCli(arguments_: readonly string[]): Promise<void> {
  const parsed = parseArguments(arguments_)
  switch (parsed.command) {
    case 'certify:adapter':
      await certifyAdapter(parsed)
      return
    case 'doctor':
      await doctor(parsed)
      return
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(usage())
      return
    case 'inspect':
      await inspect(parsed)
      return
    case 'k6:discover':
      await k6Discover(parsed)
      return
    case 'k6:plan':
      await k6Plan(parsed)
      return
    case 'k6:record':
      await k6Record(parsed)
      return
    case 'maestro:discover':
      await maestroDiscover(parsed)
      return
    case 'maestro:plan':
      await maestroPlan(parsed)
      return
    case 'maestro:record':
      await maestroRecord(parsed)
      return
    case 'merge':
      await merge(parsed)
      return
    case 'plan':
      await plan(parsed)
      return
    case 'run':
      await runWorkspaceCommand({
        config: option(parsed, 'config') ?? 'tiacore.config.mjs',
        ...(option(parsed, 'output') === undefined
          ? {}
          : { output: option(parsed, 'output')! }),
      })
      return
    default:
      throw new Error(`unknown tiacore command: ${parsed.command}\n${usage()}`)
  }
}
