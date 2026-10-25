import { createImpactPlan } from '../../../src/engine/plan/protocol.ts'
import { parseImpactGraph } from '../../../src/wire/decode.ts'
import { versus } from '../../support/bench-report.ts'
import { bothVersions, medianOf, timed } from '../../support/bench-run.ts'
import { legacy } from '../../support/legacy.ts'
import { scaleGraph } from '../../support/scale-graph.ts'
import type { Workload } from './workload.ts'

interface LegacyPlanner {
  createImpactPlan: (input: unknown) => unknown
}
interface LegacyValidator {
  parseImpactGraph: (value: unknown) => unknown
}

const SUITES = 25_000
// Calls timed per version in a round; the round keeps their median.
const REPS = 3

interface State {
  readonly graph: ReturnType<typeof scaleGraph>
  readonly input: Parameters<typeof createImpactPlan>[0]
  readonly oldPlanner: LegacyPlanner
  readonly oldValidator: LegacyValidator
}

let state: State | undefined

/** The median time of `REPS` calls of each operation. */
const measure = (plan: () => unknown, decode: () => unknown) => ({
  decode: medianOf(REPS, () => timed(decode).ms),
  plan: medianOf(REPS, () => timed(plan).ms),
})

/**
 * Protocol planning and graph decoding at monorepo scale (25,000 suites),
 * in-process: the steady-state cost of the runner-neutral planner. The CLI
 * workload measures the same data through a fresh process.
 */
export const protocol: Workload = {
  name: 'protocol',
  async setup() {
    const graph = scaleGraph(SUITES)
    state = {
      graph,
      input: {
        catalog: graph.suites,
        changes: { files: ['src/domain-2718.ts'] },
        currentEnvironmentFingerprint: graph.environmentFingerprint,
        currentFingerprint: graph.fingerprint,
        graph,
      },
      oldPlanner: await legacy<LegacyPlanner>('protocol/planner.js'),
      oldValidator: await legacy<LegacyValidator>('protocol/validate.js'),
    }
  },
  round(index) {
    if (state === undefined) throw new Error('protocol ran before its setup')
    const { graph, input, oldPlanner, oldValidator } = state
    const results = bothVersions(index, (version) =>
      version === 'current'
        ? measure(
            () => createImpactPlan(input),
            () => parseImpactGraph(graph),
          )
        : measure(
            () => oldPlanner.createImpactPlan(input),
            () => oldValidator.parseImpactGraph(graph),
          ),
    )
    return {
      ...versus('plan-25k', results.current.plan, results.legacy.plan),
      ...versus('decode-25k', results.current.decode, results.legacy.decode),
    }
  },
  summary: `createImpactPlan and parseImpactGraph on a ${SUITES}-suite protocol graph, in-process; median of ${REPS} calls per version per round`,
  teardown() {
    state = undefined
  },
  warmup: 1,
}
