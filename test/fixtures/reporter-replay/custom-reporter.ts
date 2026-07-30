import { appendFileSync } from 'node:fs'
import type { Reporter, TestCase } from 'vitest/node'

function record(testCase: TestCase, phase: string): void {
  const cached = testCase.meta().__tiacore_cached__ === true
  appendFileSync(
    new URL('./reporter-events.log', import.meta.url),
    `${phase}:${cached ? 'cached' : 'live'}:${testCase.fullName}:${testCase.result().state}\n`,
  )
}

export class CustomThirdPartyReporter implements Reporter {
  onTestCaseReady(testCase: TestCase): void {
    record(testCase, 'ready')
  }

  onTestCaseResult(testCase: TestCase): void {
    record(testCase, 'result')
  }
}
