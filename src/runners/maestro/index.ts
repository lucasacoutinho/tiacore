import * as Effect from 'effect/Effect'

import type { TiaImpactGraph, TiaImpactPlan } from '../../core/protocol.ts'
import { runPromise } from '../../host/runtime.ts'
import { catalogFingerprint } from '../external.ts'
import {
  createMaestroGraph as createGraph,
  discover,
  planSuites,
  run,
} from './program.ts'
import type {
  DiscoverMaestroOptions,
  MaestroGraphOptions,
  MaestroSuite,
  PlanMaestroOptions,
  TiaMaestroOptions,
  TiaMaestroResult,
} from './types.ts'

export type {
  DiscoverMaestroOptions,
  MaestroGraphOptions,
  MaestroSuite,
  PlanMaestroOptions,
  TiaMaestroOptions,
  TiaMaestroResult,
}

export async function discoverMaestroSuites(
  options: DiscoverMaestroOptions,
): Promise<MaestroSuite[]> {
  return runPromise(discover(options))
}

export function maestroCatalogFingerprint(
  suites: readonly MaestroSuite[],
): string {
  return catalogFingerprint(suites)
}

export function createMaestroGraph(
  options: MaestroGraphOptions,
): TiaImpactGraph {
  return createGraph(options)
}

export async function planMaestro(
  options: PlanMaestroOptions,
): Promise<TiaImpactPlan> {
  return runPromise(
    discover(options).pipe(
      Effect.flatMap((suites) => planSuites(suites, options)),
    ),
  )
}

export class TiaMaestroRunner {
  private readonly options: TiaMaestroOptions

  constructor(options: TiaMaestroOptions) {
    this.options = options
  }

  async run(): Promise<TiaMaestroResult> {
    return runPromise(run(this.options))
  }
}

export function tia(options: TiaMaestroOptions): TiaMaestroRunner {
  return new TiaMaestroRunner(options)
}
