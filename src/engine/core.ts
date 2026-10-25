import type {
  CachedTestResult,
  RunPlan,
  TiaRuntimeGraph,
} from '../core/runtime.ts'
import { runPromise } from '../host/runtime.ts'
import { CoreRun } from './core-run.ts'
import type {
  TiaCoreEngineOptions,
  TiaCoreOptions,
  TiaObservation,
} from './core-options.ts'

export type { TiaCoreEngineOptions, TiaCoreOptions, TiaObservation }

/**
 * The runner-neutral core that the Node, Bun, Playwright and generic adapters
 * share: prepare plans the run from the stored graph, commit records what the
 * run observed. A commit is skipped (null) when the project changed during the
 * run or another writer committed an incompatible graph.
 */
export class TiaCore {
  readonly cacheDir: string
  readonly options: TiaCoreEngineOptions
  readonly root: string

  private readonly run: CoreRun

  constructor(options: TiaCoreOptions) {
    this.run = new CoreRun(options)
    this.cacheDir = this.run.cacheDir
    this.options = this.run.options
    this.root = this.run.root
  }

  get plan(): RunPlan {
    return this.run.plan
  }

  async prepare(): Promise<RunPlan> {
    return runPromise(this.run.prepare())
  }

  async commit(
    observations: TiaObservation[],
    wholeTestFiles: string[],
  ): Promise<TiaRuntimeGraph | null> {
    return runPromise(this.run.commit(observations, wholeTestFiles))
  }

  replayedResults(): CachedTestResult[] {
    return this.run.replayedResults()
  }
}
