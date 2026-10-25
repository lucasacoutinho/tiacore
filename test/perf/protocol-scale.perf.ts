import { expect, test } from 'vitest'

import { createImpactPlan } from '../../src/engine/plan/protocol.ts'
import { legacy } from '../support/legacy.ts'
import { scaleGraph } from '../support/scale-graph.ts'
import { median } from '../support/stats.ts'

interface LegacyPlanner {
  createImpactPlan: (input: unknown) => unknown
}

const old = await legacy<LegacyPlanner>('protocol/planner.js')
const graph = scaleGraph(25_000)
const input = {
  catalog: graph.suites,
  changes: { files: ['src/domain-2718.ts'] },
  currentEnvironmentFingerprint: graph.environmentFingerprint,
  currentFingerprint: graph.fingerprint,
  graph,
}

// Budget: protocol-scale planning is no slower than 1.x, with 50% headroom.
// Each round times both planners back to back, so a load spike hits both
// sides of one pair; the median ratio over the rounds ignores outliers.
test(
  'plans a monorepo-scale graph no slower than the 1.x planner',
  { timeout: 60_000 },
  () => {
    const ratios: number[] = []
    for (let round = 0; round < 7; round += 1) {
      let started = performance.now()
      old.createImpactPlan(input)
      const legacyMs = performance.now() - started
      started = performance.now()
      createImpactPlan(input)
      ratios.push((performance.now() - started) / legacyMs)
    }
    expect(
      median(ratios),
      `2.0 / 1.x planning time per round: ${ratios.map((ratio) => ratio.toFixed(2)).join(', ')}`,
    ).toBeLessThan(1.5)
  },
)
