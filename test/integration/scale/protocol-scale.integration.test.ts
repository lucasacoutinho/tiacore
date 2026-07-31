import { describe, expect, test } from 'vitest'

import { createImpactPlan } from '../../../src/protocol/planner.js'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaSuiteDescriptor,
} from '../../../src/protocol/types.js'

function scaleGraph(count: number): TiaImpactGraph {
  const suites: TiaSuiteDescriptor[] = []
  const observations: TiaDependencyObservation[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `vitest:test/suite-${index}.test.ts`
    suites.push({ adapter: 'vitest', file: `test/suite-${index}.test.ts`, id, project: 'scale' })
    observations.push(
      { confidence: 'exact', kind: 'configuration', source: `test/suite-${index}.test.ts`, suiteId: id },
      { confidence: 'observed', kind: 'executed', source: `src/domain-${index % 5_000}.ts`, suiteId: id },
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

describe('protocol scale', () => {
  test('selects deterministically across a Scherie-scale graph', { timeout: 20_000 }, () => {
    const graph = scaleGraph(25_000)
    const input = {
      catalog: graph.suites,
      changes: { files: ['src/domain-2718.ts'] },
      currentEnvironmentFingerprint: graph.environmentFingerprint,
      currentFingerprint: graph.fingerprint,
      graph,
    }
    const started = performance.now()
    const first = createImpactPlan(input)
    const durationMs = performance.now() - started
    const second = createImpactPlan(input)

    expect(first).toEqual(second)
    expect(first.mode).toBe('selective')
    expect(first.selected).toHaveLength(5)
    expect(durationMs).toBeLessThan(10_000)
  })
})
