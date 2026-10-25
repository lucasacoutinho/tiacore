import { dirname, relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { parseAllDocuments } from 'yaml'

import { byCodeUnit } from '../../core/canonical.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
} from '../../core/protocol.ts'
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
} from '../external.ts'
import type {
  DiscoverMaestroOptions,
  MaestroGraphOptions,
  MaestroSuite,
  PlanMaestroOptions,
  TiaMaestroOptions,
} from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'runFlow') {
      if (typeof child === 'string') {
        paths.add(child)
      } else if (isRecord(child) && typeof child['file'] === 'string') {
        paths.add(child['file'])
      }
    }
    runFlowPaths(child, paths)
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

export const discover = Effect.fnUntraced(function* (
  options: DiscoverMaestroOptions,
) {
  const fs = yield* FileSystem.FileSystem
  const root = resolve(options.root)
  const flowsRoot = resolve(root, options.flows)
  const paths = yield* globFiles(['**/*.yaml', '**/*.yml'], { cwd: flowsRoot })
  const discovered = new Map<
    string,
    MaestroSuite & { readonly runFlows: string[] }
  >()

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
    if (
      !includesTags(tags, options.includeTags ?? [], options.excludeTags ?? [])
    ) {
      continue
    }
    const projectFile = yield* attempt(() =>
      normalizeProtocolPath(relative(root, path)),
    )
    const referenced = new Set<string>()
    for (const document of documents) {
      const content: unknown = document.toJS()
      runFlowPaths(content, referenced)
    }
    const runFlows = yield* attempt(() =>
      [...referenced].map((flow) =>
        normalizeProtocolPath(relative(root, resolve(dirname(path), flow))),
      ),
    )
    const appId = metadata['appId']
    const name = metadata['name']
    discovered.set(projectFile, {
      adapter: 'maestro',
      ...(typeof appId === 'string' ? { appId } : {}),
      file: projectFile,
      id: suiteId(options.project, projectFile),
      name: typeof name === 'string' && name.trim() !== '' ? name : projectFile,
      project: options.project,
      resourceLocks: ['maestro-device'],
      runFlows,
      tags,
    })
  }

  return [...discovered.values()]
    .map(({ runFlows, ...suite }): MaestroSuite => ({
      ...suite,
      dependsOn: runFlows
        .map((flow) => discovered.get(flow)?.id)
        .filter((id): id is string => id !== undefined)
        .sort(byCodeUnit),
    }))
    .sort((left, right) => byCodeUnit(left.id, right.id))
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
  return yield* runExternal({
    defaultArguments: ['test'],
    name: 'maestro',
    options,
    prepare: Effect.fnUntraced(function* (graph) {
      const suites = yield* discover(options)
      const plan = yield* planSuites(suites, { ...options, graph })
      return {
        plan,
        recordGraph: () =>
          createMaestroGraph({
            environmentFingerprint: options.currentEnvironmentFingerprint,
            ...(options.currentFingerprint === undefined
              ? {}
              : { fingerprint: options.currentFingerprint }),
            suites,
          }),
        suites,
      }
    }),
  })
})
