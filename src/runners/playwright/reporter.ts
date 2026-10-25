import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'

import { projectFile } from '../../engine/host-path.ts'
import {
  PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
  type PlaywrightObservation,
  type PlaywrightRunReport,
} from './protocol.ts'

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((file): file is string => typeof file === 'string')
    ? value
    : null
}

function attachmentDependencies(result: TestResult): string[] | null {
  const attachment = result.attachments.find(
    (candidate) => candidate.name === PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  )
  if (attachment === undefined) return null

  try {
    const source =
      attachment.body?.toString('utf8') ??
      (attachment.path === undefined
        ? null
        : readFileSync(attachment.path, 'utf8'))
    return source === null ? null : stringArray(JSON.parse(source))
  } catch {
    return null
  }
}

function observationState(
  test: TestCase,
  result: TestResult,
): PlaywrightObservation['state'] {
  if (result.status === 'skipped') return 'skipped'
  return test.ok() ? 'passed' : 'failed'
}

/**
 * The reporter `tia()` adds to the Playwright config. Inside a tiacore run it
 * writes what each test touched to the session file the runner reads back;
 * anywhere else it does nothing. It holds one run's observations and nothing
 * else, so a process that runs Playwright repeatedly keeps no state between
 * runs.
 */
export default class TiaPlaywrightReporter implements Reporter {
  private configuredTestIds: string[] = []
  private readonly observations = new Map<string, PlaywrightObservation>()

  onBegin(_config: unknown, suite: Suite): void {
    this.observations.clear()
    this.configuredTestIds = suite
      .allTests()
      .map((test) => test.id)
      .sort()
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const root = process.env[PLAYWRIGHT_ROOT_ENV]
    if (root === undefined) return
    const file = projectFile(root, test.location.file)
    if (file === null) return

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
    const observations = [...this.observations.values()]
    const configuredTestIds = this.configuredTestIds
    this.observations.clear()
    this.configuredTestIds = []
    if (target === undefined) return

    const report: PlaywrightRunReport = {
      configuredTestIds,
      observations,
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
