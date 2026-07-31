import type {
  PlaywrightTestArgs,
  TestType,
} from '@playwright/test'
import { fileURLToPath } from 'node:url'

import { withTiaFixture } from '../adapters/playwright/fixture.js'
import {
  TiaPlaywrightRunner,
  type TiaPlaywrightOptions,
  type TiaPlaywrightResult,
} from '../adapters/playwright/runner.js'

export type TiaPlaywrightReporter = [string]

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
  if (value === undefined) {
    return [
      fileURLToPath(
        new URL('../adapters/playwright/reporter.js', import.meta.url),
      ),
    ]
  }
  if (typeof value === 'function') {
    return withTiaFixture(value)
  }
  return new TiaPlaywrightRunner(value)
}

export type {
  TiaPlaywrightOptions,
  TiaPlaywrightResult,
}
