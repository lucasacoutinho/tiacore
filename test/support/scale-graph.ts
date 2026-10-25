import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaSuiteDescriptor,
} from '../../src/core/protocol.ts'

/** A protocol graph of `count` suites over 5,000 source files. */
export function scaleGraph(count: number): TiaImpactGraph {
  const suites: TiaSuiteDescriptor[] = []
  const observations: TiaDependencyObservation[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `vitest:test/suite-${index}.test.ts`
    suites.push({
      adapter: 'vitest',
      file: `test/suite-${index}.test.ts`,
      id,
      project: 'scale',
    })
    observations.push(
      {
        confidence: 'exact',
        kind: 'configuration',
        source: `test/suite-${index}.test.ts`,
        suiteId: id,
      },
      {
        confidence: 'observed',
        kind: 'executed',
        source: `src/domain-${index % 5_000}.ts`,
        suiteId: id,
      },
    )
  }
  return {
    complete: true,
    environmentFingerprint: 'node20-linux',
    fingerprint: 'scale-v1',
    observations,
    protocolVersion: 1,
    suites,
  }
}
