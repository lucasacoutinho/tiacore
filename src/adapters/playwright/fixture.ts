import { randomUUID } from 'node:crypto'

import type {
  BrowserContext,
  Fixtures,
  Page,
  PlaywrightTestArgs,
  Route,
  TestInfo,
  TestType,
} from '@playwright/test'

import {
  TiaEvidence,
  TIA_EVIDENCE_DIRECTORY_ENV,
  TIA_EVIDENCE_HEADER_ENV,
} from '../../integrations/evidence/index.js'

import {
  PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
} from './protocol.js'
import { coveredSourceMapFiles, sourceMapFiles } from './source-maps.js'

function tracksSource(responseUrl: string, resourceType: string): boolean {
  return (
    resourceType === 'script' ||
    resourceType === 'stylesheet' ||
    /\.(?:bundle|css|[cm]?js)(?:\?|$)/i.test(responseUrl)
  )
}

async function recordDependencies(
  context: BrowserContext,
  initialPage: Page,
  preciseCoverage: boolean,
  use: () => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const root = process.env[PLAYWRIGHT_ROOT_ENV]
  if (root === undefined || process.env[PLAYWRIGHT_SESSION_ENV] === undefined) {
    await use()
    return
  }

  const files = new Set<string>()
  const evidenceDirectory = process.env[TIA_EVIDENCE_DIRECTORY_ENV]
  const evidence =
    evidenceDirectory === undefined
      ? null
      : new TiaEvidence({
          directory: evidenceDirectory,
          ...(process.env[TIA_EVIDENCE_HEADER_ENV] === undefined
            ? {}
            : { header: process.env[TIA_EVIDENCE_HEADER_ENV] }),
          producer: `playwright:${testInfo.workerIndex}`,
          root,
        })
  const correlationId = evidence?.correlationId(
    `playwright:${testInfo.workerIndex}:${randomUUID()}`,
  )
  const correlatedRoute =
    evidence === null || correlationId === undefined
      ? null
      : async (route: Route): Promise<void> => {
          await route.continue({
            headers: {
              ...route.request().headers(),
              ...evidence.headers(correlationId),
            },
          })
        }
  const pending = new Set<Promise<void>>()
  const pages = new Set<Page>()
  const coverageStarts = new Map<Page, Promise<boolean>>()
  const fallbackFiles = new Map<Page, Map<string, Set<string>>>()

  const observe = (page: Page): void => {
    if (pages.has(page)) {
      return
    }
    pages.add(page)
    fallbackFiles.set(page, new Map())
    if (preciseCoverage) {
      coverageStarts.set(
        page,
        page.coverage.startJSCoverage({ resetOnNavigation: false }).then(
          () => true,
          () => false,
        ),
      )
    }
    page.on('response', (response) => {
      const url = response.url()
      if (!tracksSource(url, response.request().resourceType())) {
        return
      }
      const task = sourceMapFiles(url, root)
        .then((dependencies) => {
          for (const dependency of dependencies) {
            if (response.request().resourceType() === 'stylesheet') {
              files.add(dependency)
            } else {
              const byUrl = fallbackFiles.get(page)
              const target = byUrl?.get(url) ?? new Set<string>()
              target.add(dependency)
              byUrl?.set(url, target)
            }
          }
        })
        .finally(() => pending.delete(task))
      pending.add(task)
    })
  }

  observe(initialPage)
  for (const page of context.pages()) {
    observe(page)
  }
  await (coverageStarts.get(initialPage) ?? Promise.resolve(false))
  if (correlatedRoute !== null) {
    await context.route('**/*', correlatedRoute)
  }
  context.on('page', observe)
  try {
    await use()
  } finally {
    if (correlatedRoute !== null) {
      await context.unroute('**/*', correlatedRoute)
    }
  }
  await Promise.allSettled(pending)

  if (evidence !== null && correlationId !== undefined) {
    for (const file of await evidence.collect(correlationId, {
      remove: true,
    })) {
      files.add(file)
    }
  }

  for (const page of pages) {
    const coverageStarted =
      preciseCoverage &&
      (await (coverageStarts.get(page) ?? Promise.resolve(false)))
    if (!coverageStarted) {
      for (const dependencies of fallbackFiles.get(page)?.values() ?? []) {
        for (const file of dependencies) {
          files.add(file)
        }
      }
      continue
    }

    try {
      const coverage = await page.coverage.stopJSCoverage()
      const coveredUrls = new Set(coverage.map((entry) => entry.url))
      for (const entry of coverage) {
        for (const file of await coveredSourceMapFiles(
          entry.url,
          entry.source,
          entry.functions,
          root,
        )) {
          files.add(file)
        }
      }
      for (const [url, dependencies] of fallbackFiles.get(page) ?? []) {
        if (coveredUrls.has(url)) {
          continue
        }
        for (const file of dependencies) {
          files.add(file)
        }
      }
    } catch {
      for (const dependencies of fallbackFiles.get(page)?.values() ?? []) {
        for (const file of dependencies) {
          files.add(file)
        }
      }
    }
  }

  await testInfo.attach(PLAYWRIGHT_DEPENDENCIES_ATTACHMENT, {
    body: Buffer.from(JSON.stringify([...files].sort())),
    contentType: 'application/json',
  })
}

export function withTiaFixture<
  TestArguments extends PlaywrightTestArgs,
  WorkerArguments extends object,
>(
  test: TestType<TestArguments, WorkerArguments>,
): TestType<TestArguments, WorkerArguments> {
  const fixtures = {
    _tiaDependencies: [
      async (
        { page }: TestArguments & WorkerArguments,
        use: () => Promise<void>,
        testInfo: TestInfo,
      ) => {
        await recordDependencies(
          page.context(),
          page,
          page.context().browser()?.browserType().name() === 'chromium',
          use,
          testInfo,
        )
      },
      { auto: true },
    ],
  } as unknown as Fixtures<
    { _tiaDependencies: void },
    {},
    TestArguments,
    WorkerArguments
  >
  return test.extend(fixtures) as unknown as TestType<
    TestArguments,
    WorkerArguments
  >
}
