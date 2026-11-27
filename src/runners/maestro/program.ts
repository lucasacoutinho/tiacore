import { dirname, relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { parseAllDocuments } from 'yaml'

import { byCodeUnit } from '../../core/canonical.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
} from '../../core/protocol.ts'
import { normalizePath } from '../../core/path.ts'
import { normalizeProtocolPath } from '../../engine/plan/protocol.ts'
import { TiaInvalid } from '../../wire/errors.ts'
import {
  attempt,
  catalogFingerprint,
  externalGraph,
  globFiles,
  ioFailure,
  planExternal,
  protocolSuite,
  runExternal,
  withFresh,
} from '../external.ts'
import type {
  DiscoverMaestroOptions,
  MaestroGraphOptions,
  MaestroSuite,
  PlanMaestroOptions,
  TiaMaestroOptions,
} from './types.ts'
import { isRecord } from '../../core/record.ts'

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** The files a flow names, by what it does with them. */
interface References {
  /** Flows it runs with `runFlow`. */
  readonly flows: Set<string>
  /** Scripts it runs with `runScript` and media it adds with `addMedia`. */
  readonly files: Set<string>
}

function addFile(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    into.add(value)
  } else if (isRecord(value) && typeof value['file'] === 'string') {
    into.add(value['file'])
  }
}

function collectReferences(value: unknown, references: References): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'runFlow') addFile(child, references.flows)
    if (key === 'runScript') addFile(child, references.files)
    if (key === 'addMedia') {
      const media = isRecord(child) ? child['files'] : child
      for (const path of stringArray(media)) references.files.add(path)
    }
    collectReferences(child, references)
  }
}

function suiteId(project: string, file: string): string {
  return `maestro:${project}:${file}`
}

function includesTags(
  tags: readonly string[],
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (exclude.some((tag) => tags.includes(tag))) return false
  return include.length === 0 || include.some((tag) => tags.includes(tag))
}

/** Maestro's workspace configuration sits at the flow root and is not a flow. */
function isWorkspaceConfig(flowsRoot: string, path: string): boolean {
  const inside = relative(flowsRoot, path).replaceAll('\\', '/')
  return inside === 'config.yaml' || inside === 'config.yml'
}

/** The project path of a file, or undefined when it is outside the project. */
function projectPath(root: string, absolute: string): string | undefined {
  const result = normalizePath(relative(root, absolute))
  return result._tag === 'Rejected' ? undefined : result.path
}

/**
 * The project path of a file a flow names relative to itself, or undefined
 * when it cannot be followed: it is outside the project or comes from a
 * variable.
 */
function followable(
  root: string,
  flowPath: string,
  reference: string,
): string | undefined {
  return reference.includes('${')
    ? undefined
    : projectPath(root, resolve(dirname(flowPath), reference))
}

/** A flow file, whether or not its tags make it a suite. */
interface Flow {
  readonly file: string
  readonly included: boolean
  readonly metadata: Readonly<Record<string, unknown>>
  /** The project paths of the flows it runs. */
  readonly runs: readonly string[]
  readonly tags: string[]
  /** The project paths of the scripts and media it uses. */
  readonly uses: readonly string[]
  /** It names a script or media file through a variable, which cannot be followed. */
  readonly variableUses: boolean
}

/**
 * Reads every flow under the flow root, in path order. Tags decide which flows
 * are suites, but every flow is read, so a suite still depends on what it
 * reaches through a helper flow the tags leave out. A flow that is not a suite
 * cannot fail discovery with a reference that leaves the repository.
 */
const readFlows = Effect.fnUntraced(function* (
  options: DiscoverMaestroOptions,
) {
  const fs = yield* FileSystem.FileSystem
  const root = resolve(options.root)
  const flowsRoot = resolve(root, options.flows)
  const paths = yield* globFiles(['**/*.yaml', '**/*.yml'], { cwd: flowsRoot })
  const flows = new Map<string, Flow>()
  for (const path of paths.sort()) {
    if (isWorkspaceConfig(flowsRoot, path)) continue
    const source = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError(ioFailure))
    const documents = parseAllDocuments(source)
    const errors = documents.flatMap((document) => document.errors)
    if (errors.length > 0) {
      return yield* new TiaInvalid({
        message: `invalid Maestro flow ${path}: ${errors.map((error) => error.message).join('; ')}`,
      })
    }
    const parsed: unknown = documents[0]?.toJS() ?? {}
    const metadata = isRecord(parsed) ? parsed : {}
    const tags = stringArray(metadata['tags']).sort(byCodeUnit)
    const included = includesTags(
      tags,
      options.includeTags ?? [],
      options.excludeTags ?? [],
    )
    const references: References = { files: new Set(), flows: new Set() }
    for (const document of documents) {
      const content: unknown = document.toJS()
      collectReferences(content, references)
    }
    const followed = (names: ReadonlySet<string>) =>
      [...names].flatMap((name) => followable(root, path, name) ?? [])
    const file = included
      ? yield* attempt(() => normalizeProtocolPath(relative(root, path)))
      : projectPath(root, path)
    if (file === undefined) continue
    const runs = included
      ? yield* attempt(() =>
          [...references.flows].map((flow) =>
            normalizeProtocolPath(relative(root, resolve(dirname(path), flow))),
          ),
        )
      : followed(references.flows)
    flows.set(file, {
      file,
      included,
      metadata,
      runs,
      tags,
      uses: followed(references.files),
      variableUses: [...references.files].some((name) => name.includes('${')),
    })
  }
  return flows
})

/**
 * The suites a flow runs: the suites it names with `runFlow`, and those it
 * reaches through flows that are not suites.
 */
function suiteDependencies(
  flow: Flow,
  flows: ReadonlyMap<string, Flow>,
  project: string,
): string[] {
  const dependsOn = new Set<string>()
  const seen = new Set<string>()
  const pending = [...flow.runs]
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    const target = flows.get(file)
    if (target?.included === true) dependsOn.add(suiteId(project, file))
    else if (target !== undefined) pending.push(...target.runs)
  }
  return [...dependsOn].sort(byCodeUnit)
}

function suitesOf(
  flows: ReadonlyMap<string, Flow>,
  project: string,
): MaestroSuite[] {
  const suites: MaestroSuite[] = []
  for (const flow of flows.values()) {
    if (!flow.included) continue
    const appId = flow.metadata['appId']
    const name = flow.metadata['name']
    suites.push({
      adapter: 'maestro',
      ...(typeof appId === 'string' ? { appId } : {}),
      file: flow.file,
      id: suiteId(project, flow.file),
      name: typeof name === 'string' && name.trim() !== '' ? name : flow.file,
      project,
      resourceLocks: ['maestro-device'],
      tags: flow.tags,
      dependsOn: suiteDependencies(flow, flows, project),
    })
  }
  return suites.sort((left, right) => byCodeUnit(left.id, right.id))
}

/**
 * The files each suite uses beyond the suites it runs, which the graph already
 * links: the flows it reaches that are not suites, and the scripts and media of
 * every flow it reaches.
 */
function usedFiles(
  suites: readonly MaestroSuite[],
  flows: ReadonlyMap<string, Flow>,
): TiaDependencyObservation[] {
  // A script named through a variable could be any script. Linking the others
  // would make a change to it select only their flows, so then no script or
  // media is linked and a change to one stays unknown (a full run by default).
  const followUses = ![...flows.values()].some((flow) => flow.variableUses)
  const observations: TiaDependencyObservation[] = []
  for (const suite of suites) {
    const used = new Set<string>()
    const seen = new Set<string>()
    const pending = [suite.file]
    while (pending.length > 0) {
      const file = pending.pop()
      const flow = file === undefined ? undefined : flows.get(file)
      if (file === undefined || flow === undefined || seen.has(file)) continue
      seen.add(file)
      if (!flow.included) used.add(file)
      if (followUses) for (const path of flow.uses) used.add(path)
      pending.push(...flow.runs)
    }
    for (const file of seen) {
      if (flows.get(file)?.included === true) used.delete(file)
    }
    for (const source of [...used].sort(byCodeUnit)) {
      observations.push({
        confidence: 'exact',
        kind: 'fixture',
        source,
        suiteId: suite.id,
      })
    }
  }
  return observations
}

/** The suites, and what they use that a graph of suites alone cannot know. */
export const discoverFlows = Effect.fnUntraced(function* (
  options: DiscoverMaestroOptions,
) {
  const flows = yield* readFlows(options)
  const suites = suitesOf(flows, options.project)
  return { observations: usedFiles(suites, flows), suites }
})

export const discover = Effect.fnUntraced(function* (
  options: DiscoverMaestroOptions,
) {
  return suitesOf(yield* readFlows(options), options.project)
})

/** Every suite a flow runs, directly or through other flows, nearest first. */
function flowClosure(
  start: MaestroSuite,
  byId: ReadonlyMap<string, MaestroSuite>,
): MaestroSuite[] {
  const seen = new Set<string>([start.id])
  const order: MaestroSuite[] = []
  const queue = [start]
  for (const current of queue) {
    for (const id of current.dependsOn ?? []) {
      const dependency = byId.get(id)
      if (dependency === undefined || seen.has(id)) continue
      seen.add(id)
      order.push(dependency)
      queue.push(dependency)
    }
  }
  return order
}

export function createMaestroGraph(
  options: MaestroGraphOptions,
): TiaImpactGraph {
  const byId = new Map(options.suites.map((suite) => [suite.id, suite]))
  const suiteObservations: TiaDependencyObservation[] = []
  for (const suite of options.suites) {
    suiteObservations.push({
      confidence: 'exact',
      kind: 'configuration',
      source: suite.file,
      suiteId: suite.id,
    })
    for (const dependency of flowClosure(suite, byId)) {
      suiteObservations.push({
        confidence: 'exact',
        kind: 'fixture',
        source: dependency.file,
        suiteId: suite.id,
      })
    }
  }
  return externalGraph({
    environmentFingerprint: options.environmentFingerprint,
    fingerprint: options.fingerprint ?? catalogFingerprint(options.suites),
    invalidators: options.invalidators ?? [],
    knownSources: options.knownSources ?? [],
    observations: [...suiteObservations, ...(options.observations ?? [])],
    suites: options.suites.map(protocolSuite),
  })
}

export const planSuites = (
  suites: MaestroSuite[],
  options: PlanMaestroOptions,
) => planExternal('maestro', suites, options)

export const run = Effect.fn('tia.maestro.run')(function* (
  options: TiaMaestroOptions,
) {
  const planning = withFresh(options)
  return yield* runExternal({
    defaultArguments: ['test'],
    name: 'maestro',
    options,
    prepare: Effect.fnUntraced(function* (graph) {
      const { observations, suites } = yield* discoverFlows(options)
      const plan = yield* planSuites(suites, { ...planning, graph })
      return {
        plan,
        recordGraph: () =>
          createMaestroGraph({
            environmentFingerprint: options.currentEnvironmentFingerprint,
            ...(options.currentFingerprint === undefined
              ? {}
              : { fingerprint: options.currentFingerprint }),
            observations,
            suites,
          }),
        suites,
      }
    }),
  })
})
