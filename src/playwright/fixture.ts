import type {
  BrowserContext,
  Fixtures,
  Page,
  PlaywrightTestArgs,
  TestInfo,
  TestType,
} from '@playwright/test'

import {
  PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
} from './protocol.js'
import { sourceMapFiles } from './source-maps.js'

function tracksSource(responseUrl: string, resourceType: string): boolean {
  return (
    resourceType === 'script' ||
    resourceType === 'stylesheet' ||
    /\.(?:bundle|css|[cm]?js)(?:\?|$)/i.test(responseUrl)
  )
}

async function recordDependencies(
  context: BrowserContext,
  use: () => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const root = process.env[PLAYWRIGHT_ROOT_ENV]
  if (
    root === undefined ||
    process.env[PLAYWRIGHT_SESSION_ENV] === undefined
  ) {
    await use()
    return
  }

  const files = new Set<string>()
  const pending = new Set<Promise<void>>()
  const pages = new Set<Page>()

  const observe = (page: Page): void => {
    if (pages.has(page)) {
      return
    }
    pages.add(page)
    page.on('response', (response) => {
      const url = response.url()
      if (!tracksSource(url, response.request().resourceType())) {
        return
      }
      const task = sourceMapFiles(url, root)
        .then((dependencies) => {
          for (const dependency of dependencies) {
            files.add(dependency)
          }
        })
        .finally(() => pending.delete(task))
      pending.add(task)
    })
  }

  for (const page of context.pages()) {
    observe(page)
  }
  context.on('page', observe)
  await use()
  await Promise.allSettled([...pending])
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
    context: async (
      { context }: TestArguments & WorkerArguments,
      use: (value: BrowserContext) => Promise<void>,
      testInfo: TestInfo,
    ) => {
      await recordDependencies(
        context,
        async () => use(context),
        testInfo,
      )
    },
  } as unknown as Fixtures<
    {},
    {},
    TestArguments,
    WorkerArguments
  >
  return test.extend(fixtures)
}
