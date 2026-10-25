import { describe, expect, test } from 'vitest'

import { createImpactPlan } from '../../../src/engine/plan/protocol.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaSuiteDescriptor,
} from '../../../src/core/protocol.ts'
import { legacy } from '../../support/legacy.ts'

function scaleGraph(count: number): TiaImpactGraph {
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

describe('protocol scale', () => {
  test(
    'selects deterministically across a monorepo-scale graph',
    { timeout: 20_000 },
    () => {
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
    },
  )
})

interface LegacyPlanner {
  createImpactPlan: (input: unknown) => unknown
}

describe('protocol scale against 1.x', async () => {
  const old = await legacy<LegacyPlanner>('protocol/planner.js')
  const graph = scaleGraph(25_000)
  const input = {
    catalog: graph.suites,
    changes: { files: ['src/domain-2718.ts'] },
    currentEnvironmentFingerprint: graph.environmentFingerprint,
    currentFingerprint: graph.fingerprint,
    graph,
  }

  test('plans the same selection as the 1.x planner', () => {
    expect(createImpactPlan(input)).toEqual(old.createImpactPlan(input))
  })

  // ADR 0004 budget: protocol-scale planning is no slower than 1.x. The two
  // planners run interleaved so machine load hits both; the best of five runs
  // each, with 50% headroom for noise.
  test(
    'plans a monorepo-scale graph no slower than the 1.x planner',
    { timeout: 60_000 },
    () => {
      const best = { current: Infinity, legacy: Infinity }
      for (let round = 0; round < 5; round += 1) {
        let started = performance.now()
        old.createImpactPlan(input)
        best.legacy = Math.min(best.legacy, performance.now() - started)
        started = performance.now()
        createImpactPlan(input)
        best.current = Math.min(best.current, performance.now() - started)
      }
      expect(best.current).toBeLessThan(best.legacy * 1.5)
    },
  )
})
