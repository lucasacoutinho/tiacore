import picomatch from 'picomatch'

import { normalizeProtocolPath, normalizeProtocolPaths } from '../protocol/paths.js'
import {
  TIA_PROTOCOL_VERSION,
  type TiaImpactGraph,
  type TiaImpactPlan,
  type TiaImpactPlanInput,
  type TiaInvalidator,
  type TiaSuiteDescriptor,
} from '../protocol/types.js'
import { parseImpactGraph } from '../protocol/validate.js'

function suiteMap(catalog: readonly TiaSuiteDescriptor[]): Map<string, TiaSuiteDescriptor> {
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
        throw new Error(`TIA suite ${suite.id} depends on unknown suite ${dependency}`)
      }
    }
  }
  return suites
}

function addReason(
  reasons: Map<string, Set<string>>,
  suiteId: string,
  reason: string,
): void {
  const suiteReasons = reasons.get(suiteId) ?? new Set<string>()
  suiteReasons.add(reason)
  reasons.set(suiteId, suiteReasons)
}

function finalizeReasons(reasons: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries(
    [...reasons]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([suiteId, values]) => [suiteId, [...values].sort()]),
  )
}

function completeDependencies(
  suites: Map<string, TiaSuiteDescriptor>,
  selected: Set<string>,
  reasons: Map<string, Set<string>>,
): void {
  const pending = [...selected]
  while (pending.length > 0) {
    const suiteId = pending.pop()
    if (suiteId === undefined) continue
    for (const dependency of suites.get(suiteId)?.dependsOn ?? []) {
      if (selected.has(dependency)) continue
      selected.add(dependency)
      addReason(reasons, dependency, `dependency of ${suiteId}`)
      pending.push(dependency)
    }
  }
}

function planAll(
  suites: Map<string, TiaSuiteDescriptor>,
  changedFiles: string[],
  reason: string,
): TiaImpactPlan {
  const selected = [...suites.keys()].sort()
  return {
    cached: [],
    changedFiles,
    mode: 'full',
    protocolVersion: TIA_PROTOCOL_VERSION,
    reason,
    reasons: Object.fromEntries(
      selected.map((suiteId) => [suiteId, [reason]]),
    ),
    resourceLocks: [
      ...new Set(
        selected.flatMap((suiteId) => suites.get(suiteId)?.resourceLocks ?? []),
      ),
    ].sort(),
    selected,
  }
}

export function createImpactPlan(input: TiaImpactPlanInput): TiaImpactPlan {
  const suites = suiteMap(input.catalog)
  const policy = input.policy ?? {}
  const allowed = new Set(policy.allowedSuites ?? suites.keys())
  for (const suiteId of allowed) {
    if (!suites.has(suiteId)) {
      throw new Error(`TIA policy allows unknown suite ${suiteId}`)
    }
  }
  for (const suiteId of [...suites.keys()]) {
    if (!allowed.has(suiteId)) suites.delete(suiteId)
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
    const message = error instanceof Error ? error.message : String(error)
    return planAll(suites, changedFiles, `invalid impact graph: ${message}`)
  }
  if (!graph.complete) {
    return planAll(suites, changedFiles, 'the previous impact graph is incomplete')
  }
  if (
    graph.fingerprint !== input.currentFingerprint ||
    (
      policy.expectedFingerprint !== undefined &&
      graph.fingerprint !== policy.expectedFingerprint
    )
  ) {
    return planAll(suites, changedFiles, 'project structure changed')
  }
  if (
    graph.environmentFingerprint !== input.currentEnvironmentFingerprint ||
    (
      policy.expectedEnvironmentFingerprint !== undefined &&
      graph.environmentFingerprint !== policy.expectedEnvironmentFingerprint
    )
  ) {
    return planAll(suites, changedFiles, 'execution environment changed')
  }

  const ignoredChange = picomatch(policy.ignoreChanges ?? [], { dot: true })
  const reverseEdges = new Map<string, Set<string>>()
  const knownSources = new Set(
    (graph.knownSources ?? []).map(normalizeProtocolPath),
  )
  const suiteByFile = new Map<string, string>()
  for (const suite of graph.suites) {
    suiteByFile.set(normalizeProtocolPath(suite.file), suite.id)
  }
  for (const observation of graph.observations) {
    const source = normalizeProtocolPath(observation.source)
    knownSources.add(source)
    const linked = reverseEdges.get(source) ?? new Set<string>()
    linked.add(observation.suiteId)
    reverseEdges.set(source, linked)
  }

  const selected = new Set<string>()
  const reasons = new Map<string, Set<string>>()
  for (const changedFile of changedFiles) {
    if (ignoredChange(changedFile)) continue

    const invalidator = graph.invalidators?.find(({ pattern }) =>
      picomatch.isMatch(changedFile, pattern, { dot: true }),
    )
    if (invalidator !== undefined) {
      return planAll(
        suites,
        changedFiles,
        `${invalidator.reason}: ${changedFile}`,
      )
    }

    const suiteForFile = suiteByFile.get(changedFile)
    if (suiteForFile !== undefined && suites.has(suiteForFile)) {
      selected.add(suiteForFile)
      addReason(reasons, suiteForFile, `suite file changed: ${changedFile}`)
    }

    const linked = reverseEdges.get(changedFile) ?? new Set<string>()
    for (const suiteId of linked) {
      if (!suites.has(suiteId)) continue
      selected.add(suiteId)
      addReason(reasons, suiteId, `observed dependency changed: ${changedFile}`)
    }

    if (
      suiteForFile === undefined &&
      linked.size === 0 &&
      !knownSources.has(changedFile) &&
      (policy.onUnknownChange ?? 'full') === 'full'
    ) {
      return planAll(
        suites,
        changedFiles,
        `changed file is unknown to the impact graph: ${changedFile}`,
      )
    }
  }

  completeDependencies(suites, selected, reasons)
  const selectedSuites = [...selected].sort()
  const cached = [...suites.keys()].filter((suiteId) => !selected.has(suiteId)).sort()
  const resourceLocks = [
    ...new Set(
      selectedSuites.flatMap(
        (suiteId) => suites.get(suiteId)?.resourceLocks ?? [],
      ),
    ),
  ].sort()

  return {
    cached,
    changedFiles,
    mode: selectedSuites.length === 0 ? 'skip' : 'selective',
    protocolVersion: TIA_PROTOCOL_VERSION,
    reason:
      selectedSuites.length === 0
        ? 'no suites are affected'
        : `${selectedSuites.length} affected suite${selectedSuites.length === 1 ? '' : 's'}`,
    reasons: finalizeReasons(reasons),
    resourceLocks,
    selected: selectedSuites,
  }
}

export function mergeImpactGraphs(graphs: readonly TiaImpactGraph[]): TiaImpactGraph {
  if (graphs.length === 0) {
    throw new Error('at least one TIA impact graph is required')
  }
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

  const suites = new Map<string, string>()
  const suiteValues = new Map<string, TiaSuiteDescriptor>()
  for (const graph of parsed) {
    for (const suite of graph.suites) {
      const serialized = JSON.stringify(suite)
      const previous = suites.get(suite.id)
      if (previous !== undefined && previous !== serialized) {
        throw new Error(`TIA suite ${suite.id} differs between graph partitions`)
      }
      suites.set(suite.id, serialized)
      suiteValues.set(suite.id, suite)
    }
  }
  const observations = new Map<string, (typeof first.observations)[number]>()
  const invalidators = new Map<string, TiaInvalidator>()
  for (const graph of parsed) {
    for (const observation of graph.observations) {
      observations.set(JSON.stringify(observation), observation)
    }
    for (const invalidator of graph.invalidators ?? []) {
      invalidators.set(JSON.stringify(invalidator), invalidator)
    }
  }

  return {
    complete: parsed.every((graph) => graph.complete),
    environmentFingerprint: first.environmentFingerprint,
    fingerprint: first.fingerprint,
    invalidators: [...invalidators.values()].sort((left, right) =>
      left.pattern.localeCompare(right.pattern),
    ),
    knownSources: normalizeProtocolPaths(
      parsed.flatMap((graph) => graph.knownSources ?? []),
    ),
    observations: [...observations.values()].sort((left, right) =>
      `${left.suiteId}\0${left.source}\0${left.kind}\0${left.confidence}`.localeCompare(
        `${right.suiteId}\0${right.source}\0${right.kind}\0${right.confidence}`,
      ),
    ),
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites: [...suiteValues.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  }
}
