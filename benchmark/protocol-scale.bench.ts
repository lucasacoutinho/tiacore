import { bench, describe } from 'vitest'

import { createImpactPlan } from '../src/protocol/planner.js'
import type { TiaImpactGraph } from '../src/protocol/types.js'

function graph(count: number): TiaImpactGraph {
  const suites = Array.from({ length: count }, (_, index) => ({
    adapter: 'vitest',
    file: `test/suite-${index}.test.ts`,
    id: `vitest:test/suite-${index}.test.ts`,
    project: 'benchmark',
  }))
  return {
    complete: true,
    environmentFingerprint: 'benchmark',
    fingerprint: 'benchmark',
    observations: suites.flatMap((suite, index) => [
      { confidence: 'exact' as const, kind: 'configuration' as const, source: suite.file, suiteId: suite.id },
      { confidence: 'observed' as const, kind: 'executed' as const, source: `src/domain-${index % 2_000}.ts`, suiteId: suite.id },
    ]),
    protocolVersion: 1,
    suites,
  }
}

describe('protocol planning at repository scale', () => {
  const baseline = graph(10_000)
  bench('10k suites / 20k observations / selective source change', () => {
    createImpactPlan({
      catalog: baseline.suites,
      changes: { files: ['src/domain-42.ts'] },
      currentEnvironmentFingerprint: baseline.environmentFingerprint,
      currentFingerprint: baseline.fingerprint,
      graph: baseline,
    })
  })
})
