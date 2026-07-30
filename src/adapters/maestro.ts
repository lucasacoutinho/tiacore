import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import { glob } from 'tinyglobby'
import { parseAllDocuments } from 'yaml'

import { createImpactPlan } from '../core/impact.js'
import {
  executeSuites,
  readAdapterGraph,
  writeAdapterGraph,
  type AdapterExecution,
} from './execute.js'
import { normalizeProtocolPath } from '../protocol/paths.js'
import {
  TIA_PROTOCOL_VERSION,
  type TiaDependencyObservation,
  type TiaImpactGraph,
  type TiaImpactPlan,
  type TiaInvalidator,
  type TiaSuiteDescriptor,
} from '../protocol/types.js'

interface MaestroMetadata {
  appId?: unknown
  name?: unknown
  tags?: unknown
}

export interface MaestroSuite extends TiaSuiteDescriptor {
  appId?: string
  name: string
}

export interface DiscoverMaestroOptions {
  excludeTags?: string[]
  flows: string
  includeTags?: string[]
  project: string
  root: string
}

export interface MaestroGraphOptions {
  environmentFingerprint: string
  fingerprint?: string
  invalidators?: TiaInvalidator[]
  knownSources?: string[]
  observations?: TiaDependencyObservation[]
  suites: MaestroSuite[]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function runFlowPaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) runFlowPaths(item, paths)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'runFlow') {
      if (typeof child === 'string') {
        paths.add(child)
      } else if (child !== null && typeof child === 'object') {
        const file = (child as { file?: unknown }).file
        if (typeof file === 'string') paths.add(file)
      }
    }
    runFlowPaths(child, paths)
  }
}

function suiteId(project: string, file: string): string {
  return `maestro:${project}:${file}`
}

function protocolSuite(suite: MaestroSuite): TiaSuiteDescriptor {
  return {
    adapter: suite.adapter,
    ...(suite.dependsOn === undefined ? {} : { dependsOn: suite.dependsOn }),
    file: suite.file,
    id: suite.id,
    project: suite.project,
    ...(suite.resourceLocks === undefined
      ? {}
      : { resourceLocks: suite.resourceLocks }),
    ...(suite.tags === undefined ? {} : { tags: suite.tags }),
  }
}

function includesTags(
  tags: readonly string[],
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (exclude.some((tag) => tags.includes(tag))) return false
  return include.length === 0 || include.some((tag) => tags.includes(tag))
}

export async function discoverMaestroSuites(
  options: DiscoverMaestroOptions,
): Promise<MaestroSuite[]> {
  const root = resolve(options.root)
  const flowsRoot = resolve(root, options.flows)
  const paths = await glob(['**/*.yaml', '**/*.yml'], {
    absolute: true,
    cwd: flowsRoot,
    onlyFiles: true,
  })
  const discovered = new Map<
    string,
    MaestroSuite & { readonly runFlows: string[] }
  >()

  for (const path of paths.sort()) {
    const source = await readFile(path, 'utf8')
    const documents = parseAllDocuments(source)
    const errors = documents.flatMap((document) => document.errors)
    if (errors.length > 0) {
      throw new Error(
        `invalid Maestro flow ${path}: ${errors.map((error) => error.message).join('; ')}`,
      )
    }
    const metadata = (documents[0]?.toJS() ?? {}) as MaestroMetadata
    const tags = stringArray(metadata.tags).sort()
    if (
      !includesTags(
        tags,
        options.includeTags ?? [],
        options.excludeTags ?? [],
      )
    ) {
      continue
    }
    const projectFile = normalizeProtocolPath(relative(root, path))
    const referenced = new Set<string>()
    for (const document of documents.slice(1)) {
      runFlowPaths(document.toJS(), referenced)
    }
    const runFlows = [...referenced].map((flow) =>
      normalizeProtocolPath(relative(root, resolve(dirname(path), flow))),
    )
    discovered.set(projectFile, {
      adapter: 'maestro',
      ...(typeof metadata.appId === 'string'
        ? { appId: metadata.appId }
        : {}),
      file: projectFile,
      id: suiteId(options.project, projectFile),
      name:
        typeof metadata.name === 'string' && metadata.name.trim() !== ''
          ? metadata.name
          : projectFile,
      project: options.project,
      resourceLocks: ['maestro-device'],
      runFlows,
      tags,
    })
  }

  return [...discovered.values()]
    .map(({ runFlows, ...suite }) => ({
      ...suite,
      dependsOn: runFlows
        .map((flow) => discovered.get(flow)?.id)
        .filter((id): id is string => id !== undefined)
        .sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function maestroCatalogFingerprint(
  suites: readonly MaestroSuite[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...suites].sort((left, right) => left.id.localeCompare(right.id)),
      ),
    )
    .digest('hex')
}

export function createMaestroGraph(
  options: MaestroGraphOptions,
): TiaImpactGraph {
  const suiteObservations: TiaDependencyObservation[] = options.suites.flatMap(
    (suite) => [
      {
        confidence: 'exact',
        kind: 'configuration',
        source: suite.file,
        suiteId: suite.id,
      },
      ...(suite.dependsOn ?? []).flatMap((dependency) => {
        const dependencyFile = options.suites.find(
          (candidate) => candidate.id === dependency,
        )?.file
        return dependencyFile === undefined
          ? []
          : [
              {
                confidence: 'exact' as const,
                kind: 'fixture' as const,
                source: dependencyFile,
                suiteId: suite.id,
              },
            ]
      }),
    ],
  )
  return {
    complete: true,
    environmentFingerprint: options.environmentFingerprint,
    fingerprint:
      options.fingerprint ?? maestroCatalogFingerprint(options.suites),
    invalidators: options.invalidators ?? [],
    knownSources: options.knownSources ?? [],
    observations: [...suiteObservations, ...(options.observations ?? [])],
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites: options.suites.map(protocolSuite),
  }
}

export interface PlanMaestroOptions extends DiscoverMaestroOptions {
  changes: string[]
  currentEnvironmentFingerprint: string
  currentFingerprint?: string
  forceFull?: boolean
  graph: TiaImpactGraph | null
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

export async function planMaestro(
  options: PlanMaestroOptions,
): Promise<TiaImpactPlan> {
  const suites = await discoverMaestroSuites(options)
  return createImpactPlan({
    catalog: suites,
    changes: { files: options.changes, provider: 'maestro' },
    currentEnvironmentFingerprint: options.currentEnvironmentFingerprint,
    currentFingerprint:
      options.currentFingerprint ?? maestroCatalogFingerprint(suites),
    graph: options.graph,
    policy: {
      forceFull: options.forceFull ?? false,
      ignoreChanges: options.ignoreChanges ?? [],
      onUnknownChange: options.onUnknownChange ?? 'full',
    },
  })
}

export interface TiaMaestroOptions
  extends Omit<PlanMaestroOptions, 'graph'> {
  command?: string
  commandArguments?: string[]
  environment?: NodeJS.ProcessEnv
  graph?: TiaImpactGraph | null
  graphPath?: string
  maxConcurrency?: number
}

export interface TiaMaestroResult {
  executions: AdapterExecution[]
  plan: TiaImpactPlan
  status: number
  success: boolean
}

export class TiaMaestroRunner {
  constructor(private readonly options: TiaMaestroOptions) {}

  async run(): Promise<TiaMaestroResult> {
    const root = resolve(this.options.root)
    const graphPath = resolve(
      root,
      this.options.graphPath ?? '.tia/maestro/graph.json',
    )
    const graph =
      this.options.graph === undefined
        ? await readAdapterGraph(graphPath)
        : this.options.graph
    const suites = await discoverMaestroSuites(this.options)
    const plan = await planMaestro({ ...this.options, graph })
    const selected = new Set(plan.selected)
    const executions = await executeSuites({
      argumentsFor: (suite) => [
        ...(this.options.commandArguments ?? ['test']),
        resolve(root, suite.file),
      ],
      command: this.options.command ?? 'maestro',
      cwd: root,
      ...(this.options.environment === undefined
        ? {}
        : { environment: this.options.environment }),
      maxConcurrency: this.options.maxConcurrency ?? 1,
      suites: suites.filter((suite) => selected.has(suite.id)),
    })
    const status =
      executions.find((execution) => execution.status !== 0)?.status ?? 0
    if (status === 0) {
      await writeAdapterGraph(
        graphPath,
        createMaestroGraph({
          environmentFingerprint: this.options.currentEnvironmentFingerprint,
          ...(this.options.currentFingerprint === undefined
            ? {}
            : { fingerprint: this.options.currentFingerprint }),
          suites,
        }),
      )
    }
    return {
      executions,
      plan,
      status,
      success: status === 0,
    }
  }
}

export function tia(options: TiaMaestroOptions): TiaMaestroRunner {
  return new TiaMaestroRunner(options)
}
