import { describe, expect, test } from 'vitest'

import { createImpactPlan } from '../../../src/engine/plan/protocol.ts'
import { legacy } from '../../support/legacy.ts'
import { scaleGraph } from '../../support/scale-graph.ts'

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
})
