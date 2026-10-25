import { count, versus, type Observation } from '../../support/bench-report.ts'
import {
  bothVersions,
  type Both,
  type Version,
} from '../../support/bench-run.ts'
import {
  buildColdTemplate,
  coldRun,
  current,
  dropColdTemplate,
  old,
  recordedProject,
  reusedRun,
  spawnedBy,
  type Cold,
  type ColdTemplate,
  type PlanSummary,
} from '../../support/cold-start.ts'
import type { Workload } from './workload.ts'

// TiaCore's prepare and commit in a fresh process on a project in a
// repository, 2.0 against 1.x: the work every runner adapter starts with.

const SIZES = [40, 400] as const
const WARM_SIZE = 400

const entries: Record<Version, string> = { current, legacy: old }

function expectPlan(
  what: string,
  plan: PlanSummary | undefined,
  expected: PlanSummary,
): void {
  if (plan?.mode !== expected.mode || plan.affected !== expected.affected) {
    throw new Error(
      `${what} planned ${JSON.stringify(plan)}, expected ${JSON.stringify(expected)}`,
    )
  }
}

const totalOf = (run: Cold) => run.import + run.prepare + run.commit
const secondOf = (run: Cold) => run.second ?? Number.NaN
const secondSpawns = (run: Cold) => run.secondSpawns?.length ?? Number.NaN

const coldProjects = new Map<number, ColdTemplate>()

function coldProject(size: number): ColdTemplate {
  const project = coldProjects.get(size)
  if (project === undefined) throw new Error('cold ran before its setup')
  return project
}

/**
 * A first prepare and commit with no stored graph, in a project of 40 and one
 * of 400 test files. Each run is a fresh process: the time to import the entry
 * point, to prepare, to commit, their sum, and the child processes started.
 */
export const cold: Workload = {
  name: 'cold',
  round(index) {
    const result: Record<string, Observation> = {}
    for (const size of SIZES) {
      const runs = bothVersions(index, (version) => {
        const run = coldRun(coldProject(size), entries[version])
        expectPlan(`the cold run of ${version}`, run.plan, {
          affected: 0,
          mode: 'record',
        })
        return run
      })
      Object.assign(
        result,
        versus(`import-${size}`, runs.current.import, runs.legacy.import),
        versus(`prepare-${size}`, runs.current.prepare, runs.legacy.prepare),
        versus(`commit-${size}`, runs.current.commit, runs.legacy.commit),
        versus(`total-${size}`, totalOf(runs.current), totalOf(runs.legacy)),
        {
          [`spawns-${size}`]: count(spawnedBy(runs.current)),
          [`spawns-${size}.v1`]: count(spawnedBy(runs.legacy)),
        },
      )
    }
    return result
  },
  setup() {
    for (const size of SIZES) coldProjects.set(size, buildColdTemplate(size))
  },
  summary: `TiaCore prepare and commit, fresh process, no stored graph, ${SIZES.join(' and ')} test files`,
  teardown() {
    for (const project of coldProjects.values()) dropColdTemplate(project)
    coldProjects.clear()
  },
  warmup: 1,
}

interface Warm {
  readonly project: ColdTemplate
  readonly recorded: Both<string>
}

let warmState: Warm | undefined

/**
 * The prepare after a graph exists and one source file changed, in a project
 * of 400 test files. `second-prepare` is the second prepare of one process
 * (watch mode, a second project); `reuse-prepare` is the first prepare of a
 * fresh process on a stored graph, which is what each `vitest run` after the
 * first pays.
 */
export const warm: Workload = {
  name: 'warm',
  round(index) {
    if (warmState === undefined) throw new Error('warm ran before its setup')
    const { project, recorded } = warmState
    const seconds = bothVersions(index, (version) => {
      const run = coldRun(project, entries[version], 'second')
      expectPlan(`the second prepare of ${version}`, run.secondPlan, {
        affected: 1,
        mode: 'replay',
      })
      return run
    })
    const reuses = bothVersions(index + 1, (version) => {
      const run = reusedRun(project, recorded[version], entries[version])
      expectPlan(`the reused prepare of ${version}`, run.plan, {
        affected: 1,
        mode: 'replay',
      })
      return run
    })
    return {
      ...versus(
        'second-prepare',
        secondOf(seconds.current),
        secondOf(seconds.legacy),
      ),
      ...versus('reuse-prepare', reuses.current.prepare, reuses.legacy.prepare),
      ...versus('reuse-import', reuses.current.import, reuses.legacy.import),
      'second-spawns': count(secondSpawns(seconds.current)),
      'second-spawns.v1': count(secondSpawns(seconds.legacy)),
    }
  },
  setup() {
    const project = buildColdTemplate(WARM_SIZE)
    warmState = {
      project,
      recorded: {
        current: recordedProject(project, current),
        legacy: recordedProject(project, old),
      },
    }
  },
  summary: `TiaCore prepare once a graph exists and one source file changed, ${WARM_SIZE} test files: a second prepare in one process, and a first prepare in a fresh process`,
  teardown() {
    if (warmState !== undefined) dropColdTemplate(warmState.project)
    warmState = undefined
  },
  warmup: 1,
}
