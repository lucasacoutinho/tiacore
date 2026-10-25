import * as Effect from 'effect/Effect'

import type { TiaImpactGraph, TiaImpactPlan } from '../../core/protocol.ts'
import { runPromise } from '../../host/runtime.ts'
import { catalogFingerprint } from '../external.ts'
import { createGraph, discover, planSuites, run } from './program.ts'
import type {
  DiscoverK6Options,
  K6GraphOptions,
  K6Suite,
  PlanK6Options,
  TiaK6Options,
  TiaK6Result,
} from './types.ts'

export type {
  DiscoverK6Options,
  K6GraphOptions,
  K6Suite,
  PlanK6Options,
  TiaK6Options,
  TiaK6Result,
}

export async function discoverK6Suites(
  options: DiscoverK6Options,
): Promise<K6Suite[]> {
  return runPromise(discover(options))
}

export async function k6CatalogFingerprint(
  suites: readonly K6Suite[],
): Promise<string> {
  return catalogFingerprint(suites)
}

export async function createK6Graph(
  root: string,
  options: K6GraphOptions,
): Promise<TiaImpactGraph> {
  return runPromise(createGraph(root, options))
}

export async function planK6(options: PlanK6Options): Promise<TiaImpactPlan> {
  return runPromise(
    discover(options).pipe(
      Effect.flatMap((suites) => planSuites(suites, options)),
    ),
  )
}

export class TiaK6Runner {
  private readonly options: TiaK6Options

  constructor(options: TiaK6Options) {
    this.options = options
  }

  async run(): Promise<TiaK6Result> {
    return runPromise(run(this.options))
  }
}

export function tia(options: TiaK6Options): TiaK6Runner {
  return new TiaK6Runner(options)
}
