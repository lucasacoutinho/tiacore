import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { PlaywrightTestArgs, TestType } from '@playwright/test'

import { runPromise } from '../../host/runtime.ts'
import { withTiaFixture } from './fixture.ts'
import type { TiaPlaywrightOptions, TiaPlaywrightResult } from './types.ts'

export type { TiaPlaywrightOptions, TiaPlaywrightResult }

export type TiaPlaywrightReporter = [string]

export class TiaPlaywrightRunner {
  private readonly options: TiaPlaywrightOptions

  constructor(options: TiaPlaywrightOptions) {
    this.options = options
  }

  /**
   * Plans, runs `playwright test` with `arguments_` and the affected spec
   * files, and commits the graph. The engine loads on first use so a
   * Playwright worker that only wraps its test with `tia(test)` never pays
   * for it.
   */
  async run(arguments_: string[] = []): Promise<TiaPlaywrightResult> {
    const { run } = await import('./program.ts')
    return runPromise(run(this.options, arguments_))
  }
}

/**
 * The reporter module next to this entry. The built package keeps it at
 * `playwright-reporter.js` beside the entry files, one directory up when this
 * code sits in a shared chunk.
 */
export function reporterPath(base: string = import.meta.url): string {
  const candidates = [
    './playwright-reporter.js',
    '../playwright-reporter.js',
  ].map((name) => fileURLToPath(new URL(name, base)))
  return candidates.find((path) => existsSync(path)) ?? candidates[0] ?? ''
}

export function tia(): TiaPlaywrightReporter
export function tia<
  TestArguments extends PlaywrightTestArgs,
  WorkerArguments extends object,
>(
  test: TestType<TestArguments, WorkerArguments>,
): ReturnType<typeof withTiaFixture<TestArguments, WorkerArguments>>
export function tia(options: TiaPlaywrightOptions): TiaPlaywrightRunner
export function tia<
  TestArguments extends PlaywrightTestArgs,
  WorkerArguments extends object,
>(
  value?: TestType<TestArguments, WorkerArguments> | TiaPlaywrightOptions,
):
  | TiaPlaywrightReporter
  | ReturnType<typeof withTiaFixture<TestArguments, WorkerArguments>>
  | TiaPlaywrightRunner {
  if (value === undefined) return [reporterPath()]
  if (typeof value === 'function') return withTiaFixture(value)
  return new TiaPlaywrightRunner(value)
}
