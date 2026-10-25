import * as Effect from 'effect/Effect'

import type { TiaImpactGraph, TiaImpactPlan } from '../../core/protocol.ts'
import { runPromise } from '../../host/runtime.ts'
import { catalogFingerprint } from '../external.ts'
import {
  DEFAULT_REPORTS,
  createGraph,
  discover,
  parseJUnitReport as parseReport,
  planSuites,
  readReports,
  run,
} from './program.ts'
import type {
  DiscoverGradleOptions,
  GradleGraphOptions,
  GradleSuite,
  JUnitCase,
  PlanGradleOptions,
  TiaGradleOptions,
  TiaGradleResult,
} from './types.ts'

export type {
  DiscoverGradleOptions,
  GradleGraphOptions,
  GradleSuite,
  JUnitCase,
  PlanGradleOptions,
  TiaGradleOptions,
  TiaGradleResult,
}

export async function discoverGradleSuites(
  options: DiscoverGradleOptions,
): Promise<GradleSuite[]> {
  return runPromise(discover(options))
}

export function gradleCatalogFingerprint(
  suites: readonly GradleSuite[],
): string {
  return catalogFingerprint(suites)
}

export async function createGradleGraph(
  root: string,
  options: GradleGraphOptions,
): Promise<TiaImpactGraph> {
  return runPromise(createGraph(root, options))
}

export async function planGradle(
  options: PlanGradleOptions,
): Promise<TiaImpactPlan> {
  return runPromise(
    discover(options).pipe(
      Effect.flatMap((suites) => planSuites(suites, options)),
    ),
  )
}

export function parseJUnitReport(xml: string): JUnitCase[] {
  return parseReport(xml)
}

export async function readJUnitReports(
  root: string,
  patterns: readonly string[] = DEFAULT_REPORTS,
): Promise<JUnitCase[]> {
  return runPromise(readReports(root, patterns, undefined))
}

export class TiaGradleRunner {
  private readonly options: TiaGradleOptions

  constructor(options: TiaGradleOptions) {
    this.options = options
  }

  async run(): Promise<TiaGradleResult> {
    return runPromise(run(this.options))
  }
}

export function tia(options: TiaGradleOptions): TiaGradleRunner {
  return new TiaGradleRunner(options)
}
