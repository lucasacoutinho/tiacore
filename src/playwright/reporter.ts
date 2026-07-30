import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'

import { projectRelative } from '../shared/paths.js'
import {
  PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
  type PlaywrightObservation,
  type PlaywrightRunReport,
} from './protocol.js'

function attachmentDependencies(result: TestResult): string[] | null {
  const attachment = result.attachments.find(
    (candidate) =>
      candidate.name === PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  )
  if (attachment === undefined) {
    return null
  }

  try {
    const source =
      attachment.body?.toString('utf8') ??
      (attachment.path === undefined
        ? null
        : readFileSync(attachment.path, 'utf8'))
    if (source === null) {
      return null
    }
    const value = JSON.parse(source) as unknown
    return Array.isArray(value) &&
      value.every((file) => typeof file === 'string')
      ? value
      : null
  } catch {
    return null
  }
}

function observationState(
  test: TestCase,
  result: TestResult,
): PlaywrightObservation['state'] {
  if (result.status === 'skipped') {
    return 'skipped'
  }
  return test.ok() ? 'passed' : 'failed'
}

export default class TiaPlaywrightReporter implements Reporter {
  private configuredTestIds: string[] = []
  private readonly observations = new Map<string, PlaywrightObservation>()

  onBegin(_config: unknown, suite: Suite): void {
    this.configuredTestIds = suite.allTests().map((test) => test.id).sort()
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const root = process.env[PLAYWRIGHT_ROOT_ENV]
    if (root === undefined) {
      return
    }
    const file = projectRelative(root, test.location.file)
    if (file === null || file === '') {
      return
    }

    const dependencies = attachmentDependencies(result)
    this.observations.set(test.id, {
      dependenciesComplete:
        dependencies !== null || result.status === 'skipped',
      duration: result.duration,
      file,
      files: dependencies ?? [],
      fullName: test.titlePath().filter(Boolean).join(' › '),
      id: `playwright:${test.id}`,
      state: observationState(test, result),
    })
  }

  onEnd(result: FullResult): void {
    const target = process.env[PLAYWRIGHT_SESSION_ENV]
    if (target === undefined) {
      return
    }

    const report: PlaywrightRunReport = {
      configuredTestIds: this.configuredTestIds,
      observations: [...this.observations.values()],
      status: result.status,
    }
    const temporary = `${target}.${process.pid}.tmp`
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(report)}\n`, 'utf8')
    renameSync(temporary, target)
  }

  printsToStdio(): boolean {
    return false
  }
}
