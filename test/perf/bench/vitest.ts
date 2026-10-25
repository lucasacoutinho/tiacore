import { rmSync } from 'node:fs'

import {
  ms,
  perTest,
  ratio,
  versus,
  type Observation,
  type RoundResult,
} from '../../support/bench-report.ts'
import { interleave } from '../../support/bench-run.ts'
import {
  buildVitestTemplate,
  copyProject,
  dropVitestTemplate,
  editModule,
  PLAIN_PROJECT,
  runVitest,
  testsIn,
  type ProjectShape,
  type Tool,
  type VitestRun,
  type VitestTemplate,
} from '../../support/bench-vitest.ts'
import type { Workload } from './workload.ts'

const TOOLS: readonly Tool[] = ['plain', 'current', 'legacy']

interface Round {
  readonly plain: VitestRun
  readonly record: Record<'current' | 'legacy', VitestRun>
  readonly replay: Record<'current' | 'legacy', VitestRun>
}

function runOf(runs: ReadonlyMap<Tool, VitestRun>, tool: Tool): VitestRun {
  const run = runs.get(tool)
  if (run === undefined) throw new Error(`no ${tool} run`)
  return run
}

function expect(condition: boolean, what: string, run: VitestRun): void {
  if (!condition) {
    throw new Error(`${what}: ${JSON.stringify(run)}`)
  }
}

/**
 * One round: `vitest run` in a fresh copy of the project with no plugin, with
 * the 2.0 plugin and with the 1.x plugin (rotating who goes first), then a
 * replay of each plugin's recorded project after one module changed.
 */
function runRound(
  templates: ReadonlyMap<Tool, VitestTemplate>,
  shape: ProjectShape,
  index: number,
): Round {
  const total = testsIn(shape)
  const roots: string[] = []
  const recorded = new Map<Tool, string>()
  const runs = new Map<Tool, VitestRun>()
  try {
    for (const tool of interleave(TOOLS, index)) {
      const project = templates.get(tool)
      if (project === undefined) throw new Error(`no ${tool} project`)
      const root = copyProject(project)
      roots.push(root)
      const run = runVitest(root)
      expect(run.passed === total && run.failed === 0, `${tool} record`, run)
      runs.set(tool, run)
      recorded.set(tool, root)
    }
    const replays = new Map<Tool, VitestRun>()
    for (const tool of interleave(['current', 'legacy'] as const, index)) {
      const project = templates.get(tool)
      const source = recorded.get(tool)
      if (project === undefined || source === undefined) {
        throw new Error(`no recorded ${tool} project`)
      }
      const root = copyProject(project, source)
      roots.push(root)
      editModule(root, 0)
      const run = runVitest(root)
      // The tests that use the module run; the rest are replayed, not run.
      expect(
        run.failed === 0 && run.passed > 0 && run.passed < total,
        `${tool} replay`,
        run,
      )
      replays.set(tool, run)
    }
    return {
      plain: runOf(runs, 'plain'),
      record: {
        current: runOf(runs, 'current'),
        legacy: runOf(runs, 'legacy'),
      },
      replay: {
        current: runOf(replays, 'current'),
        legacy: runOf(replays, 'legacy'),
      },
    }
  } finally {
    for (const root of roots) rmSync(root, { force: true, recursive: true })
  }
}

function observations(result: Round, tests: number): RoundResult {
  const overhead = (run: VitestRun) => (run.ms - result.plain.ms) / tests
  const metrics: Record<string, Observation> = {
    plain: ms(result.plain.ms),
    'record-overhead': perTest(overhead(result.record.current)),
    'record-overhead.v1': perTest(overhead(result.record.legacy)),
    'replay-vs-plain': ratio(result.replay.current.ms / result.plain.ms),
    'replay-vs-plain.v1': ratio(result.replay.legacy.ms / result.plain.ms),
  }
  return {
    ...metrics,
    ...versus('record', result.record.current.ms, result.record.legacy.ms),
    ...versus('replay', result.replay.current.ms, result.replay.legacy.ms),
  }
}

export interface VitestWorkloadOptions {
  readonly extra?: (index: number) => RoundResult
  readonly name: string
  readonly shape: ProjectShape
  readonly summary: string
}

/** A Vitest end-to-end workload over a generated project of `shape`. */
export function vitestWorkload(options: VitestWorkloadOptions): Workload {
  const templates = new Map<Tool, VitestTemplate>()
  const tests = testsIn(options.shape)
  return {
    name: options.name,
    round(index) {
      return {
        ...observations(runRound(templates, options.shape, index), tests),
        ...options.extra?.(index),
      }
    },
    setup() {
      for (const tool of TOOLS) {
        templates.set(tool, buildVitestTemplate(options.shape, tool))
      }
    },
    summary: options.summary,
    teardown() {
      for (const project of templates.values()) dropVitestTemplate(project)
      templates.clear()
    },
    warmup: 1,
  }
}

const describe = (shape: ProjectShape) =>
  `${shape.testFiles} files x ${shape.testsPerFile} tests over ${shape.modules} modules`

export const vitest = vitestWorkload({
  name: 'vitest',
  shape: PLAIN_PROJECT,
  summary: `vitest run of a generated project (${describe(PLAIN_PROJECT)}): no plugin, recording with each plugin, replaying one changed module; wall time of fresh processes`,
})
