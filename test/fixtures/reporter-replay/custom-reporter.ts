import { appendFileSync } from 'node:fs'
import type { Reporter, TestCase } from 'vitest/node'

function record(testCase: TestCase, event: string): void {
  const cached = testCase.meta().__tiacore_cached__ === true
  appendFileSync(
    new URL('./reporter-events.log', import.meta.url),
    `${event}:${cached ? 'cached' : 'live'}:${testCase.fullName}\n`,
  )
}

export class CustomThirdPartyReporter implements Reporter {
  // Vitest applies a batched task update before dispatching its events, so a
  // live case's state at ready time is pending or already final depending on
  // whether its prepare and finish events shared a batch.
  onTestCaseReady(testCase: TestCase): void {
    record(testCase, 'ready')
  }

  onTestCaseResult(testCase: TestCase): void {
    record(testCase, `result:${testCase.result().state}`)
  }
}
