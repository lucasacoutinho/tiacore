import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
  type PlaywrightRunReport,
} from '../../src/runners/playwright/protocol.ts'
import Reporter from '../../src/runners/playwright/reporter.ts'
import { assertNoLeak } from '../support/leak.ts'

let directory = ''
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tiacore-playwright-reporter-'))
  saved = {
    root: process.env[PLAYWRIGHT_ROOT_ENV],
    session: process.env[PLAYWRIGHT_SESSION_ENV],
  }
  process.env[PLAYWRIGHT_ROOT_ENV] = join(directory, 'project')
  process.env[PLAYWRIGHT_SESSION_ENV] = join(directory, 'runtime/session.json')
})

afterEach(() => {
  for (const [name, key] of [
    ['root', PLAYWRIGHT_ROOT_ENV],
    ['session', PLAYWRIGHT_SESSION_ENV],
  ] as const) {
    const value = saved[name]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(directory, { force: true, recursive: true })
})

interface FakeTest {
  file?: string
  id: string
  ok?: boolean
  titlePath?: string[]
}

function fakeTest(options: FakeTest): TestCase {
  const fake = {
    id: options.id,
    location: { file: options.file ?? join(directory, 'project/a.spec.ts') },
    ok: () => options.ok ?? true,
    titlePath: () =>
      options.titlePath ?? ['', 'chromium', 'a.spec.ts', 'works'],
  }
  return fake as unknown as TestCase
}

function fakeResult(
  status: TestResult['status'],
  dependencies?: unknown,
  duration = 12,
): TestResult {
  const attachments =
    dependencies === undefined
      ? []
      : [
          {
            body: Buffer.from(JSON.stringify(dependencies)),
            contentType: 'application/json',
            name: PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
          },
        ]
  return { attachments, duration, status } as unknown as TestResult
}

function fakeSuite(ids: string[]): Suite {
  return {
    allTests: () => ids.map((id) => ({ id })),
  } as unknown as Suite
}

const finished = (status: FullResult['status']): FullResult => ({
  duration: 1,
  startTime: new Date(0),
  status,
})

function written(): PlaywrightRunReport {
  return JSON.parse(
    readFileSync(join(directory, 'runtime/session.json'), 'utf8'),
  )
}

describe('the reporter', () => {
  test('keeps the default terminal reporter', () => {
    expect(new Reporter().printsToStdio()).toBe(false)
  })

  test('is inert outside a tiacore run', () => {
    delete process.env[PLAYWRIGHT_ROOT_ENV]
    delete process.env[PLAYWRIGHT_SESSION_ENV]
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite(['t1']))
    reporter.onTestEnd(fakeTest({ id: 't1' }), fakeResult('passed', []))
    reporter.onEnd(finished('passed'))
    expect(existsSync(join(directory, 'runtime'))).toBe(false)
  })

  test('records nothing without a root but still writes the session', () => {
    delete process.env[PLAYWRIGHT_ROOT_ENV]
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite(['t1']))
    reporter.onTestEnd(fakeTest({ id: 't1' }), fakeResult('passed', []))
    reporter.onEnd(finished('passed'))
    expect(written()).toEqual({
      configuredTestIds: ['t1'],
      observations: [],
      status: 'passed',
    })
  })

  test('writes the configured ids sorted and one observation per test', () => {
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite(['t2', 't1']))
    reporter.onTestEnd(
      fakeTest({ id: 't1' }),
      fakeResult('passed', ['src/a.js']),
    )
    reporter.onEnd(finished('passed'))
    expect(written()).toEqual({
      configuredTestIds: ['t1', 't2'],
      observations: [
        {
          dependenciesComplete: true,
          duration: 12,
          file: 'a.spec.ts',
          files: ['src/a.js'],
          fullName: 'chromium › a.spec.ts › works',
          id: 'playwright:t1',
          state: 'passed',
        },
      ],
      status: 'passed',
    })
    expect(
      readFileSync(join(directory, 'runtime/session.json'), 'utf8'),
    ).toMatch(/\}\n$/u)
  })

  test('skips specs outside the root and the root itself', () => {
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite(['t1', 't2']))
    reporter.onTestEnd(
      fakeTest({ file: join(directory, 'elsewhere/a.spec.ts'), id: 't1' }),
      fakeResult('passed', []),
    )
    reporter.onTestEnd(
      fakeTest({ file: join(directory, 'project'), id: 't2' }),
      fakeResult('passed', []),
    )
    reporter.onEnd(finished('passed'))
    expect(written().observations).toEqual([])
  })

  test('accepts only an array of strings from the attachment', () => {
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite(['a', 'b', 'c', 'd']))
    reporter.onTestEnd(fakeTest({ id: 'a' }), fakeResult('passed', [1, 2]))
    reporter.onTestEnd(fakeTest({ id: 'b' }), fakeResult('passed', { a: 1 }))
    reporter.onTestEnd(fakeTest({ id: 'c' }), fakeResult('passed'))
    const broken = fakeResult('passed', [])
    broken.attachments[0] = {
      body: Buffer.from('not json'),
      contentType: 'application/json',
      name: PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
    }
    reporter.onTestEnd(fakeTest({ id: 'd' }), broken)
    reporter.onEnd(finished('passed'))
    expect(
      written().observations.map((entry) => [
        entry.id,
        entry.dependenciesComplete,
        entry.files,
      ]),
    ).toEqual([
      ['playwright:a', false, []],
      ['playwright:b', false, []],
      ['playwright:c', false, []],
      ['playwright:d', false, []],
    ])
  })

  test('reads the attachment from its file when it has no body', () => {
    const path = join(directory, 'attachment.json')
    writeFileSync(path, JSON.stringify(['src/b.js']))
    const reporter = new Reporter()
    const result = fakeResult('passed')
    result.attachments.push({
      contentType: 'application/json',
      name: PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
      path,
    })
    reporter.onBegin(undefined, fakeSuite(['t1']))
    reporter.onTestEnd(fakeTest({ id: 't1' }), result)
    reporter.onEnd(finished('passed'))
    expect(written().observations[0]).toMatchObject({
      dependenciesComplete: true,
      files: ['src/b.js'],
    })
  })

  test('a skipped test is complete without evidence', () => {
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite(['t1']))
    reporter.onTestEnd(fakeTest({ id: 't1' }), fakeResult('skipped'))
    reporter.onEnd(finished('passed'))
    expect(written().observations[0]).toMatchObject({
      dependenciesComplete: true,
      files: [],
      state: 'skipped',
    })
  })

  test.each([
    ['passed', true, 'passed'],
    ['failed', false, 'failed'],
    ['timedOut', false, 'failed'],
    ['interrupted', false, 'failed'],
    // A test that failed once and passed on retry, or that is expected to fail.
    ['failed', true, 'passed'],
  ] as const)(
    'maps a %s attempt with ok()=%s to %s',
    (status, ok, expected) => {
      const reporter = new Reporter()
      reporter.onBegin(undefined, fakeSuite(['t1']))
      reporter.onTestEnd(fakeTest({ id: 't1', ok }), fakeResult(status, []))
      reporter.onEnd(finished('passed'))
      expect(written().observations[0]?.state).toBe(expected)
    },
  )

  test('with retries only the last attempt is recorded', () => {
    const reporter = new Reporter()
    const test1 = fakeTest({ id: 't1' })
    reporter.onBegin(undefined, fakeSuite(['t1']))
    reporter.onTestEnd(test1, fakeResult('failed', ['src/first.js'], 5))
    reporter.onTestEnd(test1, fakeResult('passed', ['src/second.js'], 9))
    reporter.onEnd(finished('passed'))
    expect(written().observations).toEqual([
      expect.objectContaining({
        duration: 9,
        files: ['src/second.js'],
        id: 'playwright:t1',
      }),
    ])
  })

  test('writes the run status as Playwright reports it', () => {
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite([]))
    reporter.onEnd(finished('timedout'))
    expect(written().status).toBe('timedout')
  })

  test('a second run in the same process starts clean', () => {
    const reporter = new Reporter()
    reporter.onBegin(undefined, fakeSuite(['t1']))
    reporter.onTestEnd(fakeTest({ id: 't1' }), fakeResult('passed', []))
    reporter.onEnd(finished('passed'))

    reporter.onBegin(undefined, fakeSuite(['t2']))
    reporter.onEnd(finished('passed'))
    expect(written()).toEqual({
      configuredTestIds: ['t2'],
      observations: [],
      status: 'passed',
    })
  })

  test('retains nothing across repeated runs in one process', async () => {
    const reporter = new Reporter()
    const ids = Array.from({ length: 50 }, (_, index) => `t${index}`)
    const subjects = ids.map((id) => fakeTest({ id }))
    const result = fakeResult('passed', ['src/a.js', 'src/b.js'])
    const measured = await assertNoLeak(
      () => {
        reporter.onBegin(undefined, fakeSuite(ids))
        for (const subject of subjects) reporter.onTestEnd(subject, result)
        reporter.onEnd(finished('passed'))
      },
      { bytesPerOperation: 512, iterations: 40 },
    )
    expect(measured.bytesPerOperation).toBeLessThan(512)
  })
})
