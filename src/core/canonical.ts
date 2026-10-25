import type { TiaImpactGraph, TiaSuiteDescriptor } from './protocol.ts'

export function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Sorts values by a string key in code-unit order, computing each key once. */
export function sortByKey<T>(
  values: readonly T[],
  key: (value: T) => string,
): T[] {
  return values
    .map((value): [string, T] => [key(value), value])
    .sort(([left], [right]) => byCodeUnit(left, right))
    .map(([, value]) => value)
}

export const invalidatorKey = (invalidator: {
  readonly pattern: string
  readonly reason: string
}): string => `${invalidator.pattern}\0${invalidator.reason}`

export const observationKey = (observation: {
  readonly confidence: string
  readonly kind: string
  readonly source: string
  readonly suiteId: string
}): string =>
  `${observation.suiteId}\0${observation.source}\0${observation.kind}\0${observation.confidence}`

function canonicalSuite(suite: TiaSuiteDescriptor): TiaSuiteDescriptor {
  return {
    adapter: suite.adapter,
    ...(suite.dependsOn === undefined
      ? {}
      : { dependsOn: [...suite.dependsOn].sort(byCodeUnit) }),
    file: suite.file,
    id: suite.id,
    project: suite.project,
    ...(suite.resourceLocks === undefined
      ? {}
      : { resourceLocks: [...suite.resourceLocks].sort(byCodeUnit) }),
    ...(suite.tags === undefined
      ? {}
      : { tags: [...suite.tags].sort(byCodeUnit) }),
  }
}

/** Puts every collection of a validated graph in canonical code-unit order. */
export function canonicalGraph(graph: TiaImpactGraph): TiaImpactGraph {
  return {
    complete: graph.complete,
    environmentFingerprint: graph.environmentFingerprint,
    fingerprint: graph.fingerprint,
    ...(graph.invalidators === undefined
      ? {}
      : { invalidators: sortByKey(graph.invalidators, invalidatorKey) }),
    ...(graph.knownSources === undefined
      ? {}
      : { knownSources: [...graph.knownSources].sort(byCodeUnit) }),
    observations: sortByKey(graph.observations, observationKey),
    protocolVersion: graph.protocolVersion,
    suites: sortByKey(graph.suites, (suite) => suite.id).map(canonicalSuite),
  }
}
