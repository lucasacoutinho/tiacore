import * as Match from 'effect/Match'

import {
  byCodeUnit,
  invalidatorKey,
  observationKey,
} from '../../core/canonical.ts'
import { normalizePath } from '../../core/path.ts'
import {
  TIA_PROTOCOL_VERSION,
  type TiaImpactGraph,
  type TiaImpactPlan,
  type TiaImpactPlanInput,
  type TiaInvalidator,
  type TiaSuiteDescriptor,
} from '../../core/protocol.ts'
import {
  select,
  type ItemReason,
  type SelectionItem,
} from '../../core/select.ts'
import { parseImpactGraph } from '../../wire/decode.ts'
import { errorMessage } from '../../wire/errors.ts'
import { globMatcher } from '../glob.ts'

/** Normalizes a project-relative path, throwing for paths outside the project. */
export function normalizeProtocolPath(value: string): string {
  const result = normalizePath(value)
  if (result._tag === 'Rejected') {
    throw new Error(`TIA protocol paths must be project-relative: ${value}`)
  }
  return result.path
}

export function normalizeProtocolPaths(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeProtocolPath))].sort(byCodeUnit)
}

function catalogSuites(
  catalog: readonly TiaSuiteDescriptor[],
): Map<string, TiaSuiteDescriptor> {
  const suites = new Map<string, TiaSuiteDescriptor>()
  for (const suite of catalog) {
    if (suite.id.trim() === '' || suites.has(suite.id)) {
      throw new Error(`duplicate or empty TIA suite id: ${suite.id}`)
    }
    normalizeProtocolPath(suite.file)
    suites.set(suite.id, suite)
  }
  for (const suite of catalog) {
    for (const dependency of suite.dependsOn ?? []) {
      if (!suites.has(dependency)) {
        throw new Error(
          `TIA suite ${suite.id} depends on unknown suite ${dependency}`,
        )
      }
    }
  }
  return suites
}

function resourceLocks(
  suites: ReadonlyMap<string, TiaSuiteDescriptor>,
  selected: readonly string[],
): string[] {
  return [
    ...new Set(selected.flatMap((id) => suites.get(id)?.resourceLocks ?? [])),
  ].sort(byCodeUnit)
}

function planAll(
  suites: ReadonlyMap<string, TiaSuiteDescriptor>,
  changedFiles: string[],
  reason: string,
): TiaImpactPlan {
  const selected = [...suites.keys()].sort(byCodeUnit)
  return {
    cached: [],
    changedFiles,
    mode: 'full',
    protocolVersion: TIA_PROTOCOL_VERSION,
    reason,
    reasons: Object.fromEntries(selected.map((id) => [id, [reason]])),
    resourceLocks: resourceLocks(suites, selected),
    selected,
  }
}

function describe(reason: ItemReason): string {
  return Match.valueTags(reason, {
    Dependency: ({ path }) => `observed dependency changed: ${path}`,
    Group: ({ reason: group }) =>
      Match.valueTags(group, {
        File: ({ path }) => `suite file changed: ${path}`,
        Rerun: () => 'previous run failed',
        Residue: () => 'previous run failed',
      }),
    NeededBy: ({ id }) => `dependency of ${id}`,
    Rerun: () => 'previous run failed',
  })
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Plans which suites of a protocol v1 catalog must run for a change set. */
export function createImpactPlan(input: TiaImpactPlanInput): TiaImpactPlan {
  const suites = catalogSuites(input.catalog)
  const policy = input.policy ?? {}
  const allowed = new Set(policy.allowedSuites ?? suites.keys())
  for (const id of allowed) {
    if (!suites.has(id))
      throw new Error(`TIA policy allows unknown suite ${id}`)
  }
  for (const id of suites.keys()) {
    if (!allowed.has(id)) suites.delete(id)
  }

  const changedFiles = normalizeProtocolPaths(input.changes.files)
  if (policy.forceFull === true) {
    return planAll(suites, changedFiles, 'policy requires a full run')
  }
  if (input.graph === null) {
    return planAll(suites, changedFiles, 'no compatible impact graph found')
  }
  let graph: TiaImpactGraph
  try {
    graph = parseImpactGraph(input.graph)
  } catch (error) {
    return planAll(
      suites,
      changedFiles,
      `invalid impact graph: ${errorMessage(error)}`,
    )
  }
  if (!graph.complete) {
    return planAll(
      suites,
      changedFiles,
      'the previous impact graph is incomplete',
    )
  }
  if (
    graph.fingerprint !== input.currentFingerprint ||
    (policy.expectedFingerprint !== undefined &&
      graph.fingerprint !== policy.expectedFingerprint)
  ) {
    return planAll(suites, changedFiles, 'project structure changed')
  }
  if (
    graph.environmentFingerprint !== input.currentEnvironmentFingerprint ||
    (policy.expectedEnvironmentFingerprint !== undefined &&
      graph.environmentFingerprint !== policy.expectedEnvironmentFingerprint)
  ) {
    return planAll(suites, changedFiles, 'execution environment changed')
  }

  const ignored = globMatcher(policy.ignoreChanges ?? [])
  const changes = changedFiles.filter((path) => !ignored(path))
  const invalidators = (graph.invalidators ?? []).map(
    (invalidator): [TiaInvalidator, (path: string) => boolean] => [
      invalidator,
      globMatcher(invalidator.pattern),
    ],
  )
  const structural = new Map<string, string>()
  for (const path of changes) {
    const match = invalidators.find(([, matches]) => matches(path))
    if (match !== undefined) structural.set(path, match[0].reason)
  }

  const deps = new Map<string, string[]>()
  for (const observation of graph.observations) {
    const sources = deps.get(observation.suiteId)
    if (sources === undefined)
      deps.set(observation.suiteId, [observation.source])
    else sources.push(observation.source)
  }
  const graphFiles = new Map(
    graph.suites.map((suite) => [suite.id, suite.file]),
  )
  const items = [...suites.values()].map((suite): SelectionItem => ({
    deps: deps.get(suite.id) ?? [],
    group: suite.id,
    id: suite.id,
    needs: (suite.dependsOn ?? []).filter((id) => suites.has(id)),
    rerun: false,
  }))

  const selection = select({
    changes,
    groups: items.map((item) => ({
      coarse: [],
      exact: true,
      file: graphFiles.get(item.id),
      key: item.id,
      rerun: false,
    })),
    items,
    known: [
      ...(graph.knownSources ?? []),
      ...graph.observations.map((observation) => observation.source),
      ...graphFiles.values(),
    ],
    onUnknown: policy.onUnknownChange ?? 'full',
    structural,
  })

  if (selection._tag === 'Full') {
    const { cause } = selection
    return planAll(
      suites,
      changedFiles,
      cause._tag === 'Structural'
        ? `${cause.reason}: ${cause.path}`
        : `changed file is unknown to the impact graph: ${cause.path}`,
    )
  }

  const selected = [...selection.items]
  const chosen = new Set(selected)
  const reasons = Object.fromEntries(
    selected.map((id) => [
      id,
      [...new Set((selection.itemReasons.get(id) ?? []).map(describe))].sort(
        byCodeUnit,
      ),
    ]),
  )
  return {
    cached: [...suites.keys()].filter((id) => !chosen.has(id)).sort(byCodeUnit),
    changedFiles,
    mode: selected.length === 0 ? 'skip' : 'selective',
    protocolVersion: TIA_PROTOCOL_VERSION,
    reason:
      selected.length === 0
        ? 'no suites are affected'
        : plural(selected.length, 'affected suite'),
    reasons,
    resourceLocks: resourceLocks(suites, selected),
    selected,
  }
}

function valuesByKey<T>(map: ReadonlyMap<string, T>): T[] {
  return [...map]
    .sort(([left], [right]) => byCodeUnit(left, right))
    .map(([, value]) => value)
}

/** Merges graph partitions recorded with the same fingerprints. */
export function mergeImpactGraphs(
  graphs: readonly TiaImpactGraph[],
): TiaImpactGraph {
  const parsed = graphs.map(parseImpactGraph)
  const first = parsed[0]
  if (first === undefined) {
    throw new Error('at least one TIA impact graph is required')
  }
  for (const graph of parsed.slice(1)) {
    if (
      graph.fingerprint !== first.fingerprint ||
      graph.environmentFingerprint !== first.environmentFingerprint
    ) {
      throw new Error('TIA impact graphs have incompatible fingerprints')
    }
  }

  const suites = new Map<string, [string, TiaSuiteDescriptor]>()
  const observations = new Map<string, TiaImpactGraph['observations'][number]>()
  const invalidators = new Map<string, TiaInvalidator>()
  for (const graph of parsed) {
    for (const suite of graph.suites) {
      const serialized = JSON.stringify(suite)
      const previous = suites.get(suite.id)
      if (previous !== undefined && previous[0] !== serialized) {
        throw new Error(
          `TIA suite ${suite.id} differs between graph partitions`,
        )
      }
      suites.set(suite.id, [serialized, suite])
    }
    for (const observation of graph.observations) {
      observations.set(observationKey(observation), observation)
    }
    for (const invalidator of graph.invalidators ?? []) {
      invalidators.set(invalidatorKey(invalidator), invalidator)
    }
  }
  return {
    complete: parsed.every((graph) => graph.complete),
    environmentFingerprint: first.environmentFingerprint,
    fingerprint: first.fingerprint,
    invalidators: valuesByKey(invalidators),
    knownSources: normalizeProtocolPaths(
      parsed.flatMap((graph) => graph.knownSources ?? []),
    ),
    observations: valuesByKey(observations),
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites: valuesByKey(suites).map(([, suite]) => suite),
  }
}
