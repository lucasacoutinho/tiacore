import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestInfo } from '@playwright/test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { TIA_EVIDENCE_DIRECTORY_ENV } from '../../src/evidence/index.ts'
import { withTiaFixture } from '../../src/runners/playwright/fixture.ts'
import {
  PLAYWRIGHT_DEPENDENCIES_ATTACHMENT,
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
} from '../../src/runners/playwright/protocol.ts'
import { clearSourceMapCaches } from '../../src/runners/playwright/source-maps.ts'
import { assertNoLeak } from '../support/leak.ts'

// A page and a context with Playwright's listener API and nothing else. The
// context reports no browser, so the fixture records responses, not V8
// coverage.
class FakePage extends EventEmitter {
  constructor(private readonly owner: FakeContext) {
    super()
  }

  context(): FakeContext {
    return this.owner
  }
}

type RouteHandler = (route: {
  continue: (options: { headers: Record<string, string> }) => Promise<void>
  request: () => { headers: () => Record<string, string> }
}) => Promise<void>

class FakeContext extends EventEmitter {
  private readonly open: FakePage[] = []
  readonly routes = new Set<RouteHandler>()

  async route(_pattern: string, handler: RouteHandler): Promise<void> {
    this.routes.add(handler)
  }

  async unroute(_pattern: string, handler: RouteHandler): Promise<void> {
    this.routes.delete(handler)
  }

  /** The correlation header the fixture adds to a request. */
  async correlationId(): Promise<string> {
    let headers: Record<string, string> = {}
    for (const handler of this.routes) {
      await handler({
        continue: async (options) => {
          headers = options.headers
        },
        request: () => ({ headers: () => ({}) }),
      })
    }
    return headers['x-tiacore-correlation-id'] ?? ''
  }

  browser(): null {
    return null
  }

  newPage(): FakePage {
    const page = new FakePage(this)
    this.open.push(page)
    this.emit('page', page)
    return page
  }

  pages(): FakePage[] {
    return [...this.open]
  }
}

type FixtureBody = (
  args: { page: FakePage },
  use: () => Promise<void>,
  testInfo: TestInfo,
) => Promise<void>

function fixtureBody(): FixtureBody {
  let fixtures: unknown
  const base = {
    extend: (value: unknown) => {
      fixtures = value
      return base
    },
  }
  withTiaFixture(base as never)
  return (fixtures as { _tiaDependencies: [FixtureBody, object] })
    ._tiaDependencies[0]
}

interface Attachment {
  body: Buffer
  name: string
}

function testInfo(attachments: Attachment[] = []): TestInfo {
  return {
    attach: async (name: string, options: { body: Buffer }) => {
      attachments.push({ body: options.body, name })
    },
    workerIndex: 0,
  } as unknown as TestInfo
}

function scriptResponse(url: string) {
  return { request: () => ({ resourceType: () => 'script' }), url: () => url }
}

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tiacore-playwright-fixture-'))
  vi.stubEnv(PLAYWRIGHT_ROOT_ENV, root)
  vi.stubEnv(PLAYWRIGHT_SESSION_ENV, join(root, 'session.json'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  clearSourceMapCaches()
  rmSync(root, { force: true, recursive: true })
})

describe('the dependency fixture', () => {
  test('records the scripts the page loaded during the test', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/app.js'), '')
    const page = new FakeContext().newPage()
    const attachments: Attachment[] = []

    await fixtureBody()(
      { page },
      async () => {
        // Port 9 refuses the download, which leaves the script's own path.
        page.emit('response', scriptResponse('http://127.0.0.1:9/src/app.js'))
      },
      testInfo(attachments),
    )

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.name).toBe(PLAYWRIGHT_DEPENDENCIES_ATTACHMENT)
    expect(JSON.parse(attachments[0]?.body.toString('utf8') ?? '')).toEqual([
      'src/app.js',
    ])
  })

  test('observes a page opened during the test and lets go of it afterwards', async () => {
    const context = new FakeContext()
    const page = context.newPage()
    let popup: FakePage | undefined

    await fixtureBody()(
      { page },
      async () => {
        popup = context.newPage()
        expect(popup.listenerCount('response')).toBe(1)
      },
      testInfo(),
    )

    expect(popup?.listenerCount('response')).toBe(0)
  })

  test('removes its listeners from a page and context that outlive the test', async () => {
    // A worker-scoped page or context, as a project's own fixtures may build.
    const context = new FakeContext()
    const page = context.newPage()
    const body = fixtureBody()

    for (let run = 0; run < 3; run += 1) {
      await body(
        { page },
        async () => {
          expect(page.listenerCount('response')).toBe(1)
        },
        testInfo(),
      )
      expect(page.listenerCount('response')).toBe(0)
      expect(context.listenerCount('page')).toBe(0)
    }

    // A page a later test opens is not observed by a test that has finished.
    expect(context.newPage().listenerCount('response')).toBe(0)
  })

  test('retains nothing of a finished test on a page shared between tests', async () => {
    const page = new FakeContext().newPage()
    const body = fixtureBody()
    page.setMaxListeners(0)
    const measured = await assertNoLeak(
      () =>
        body(
          { page },
          async () => {
            page.emit(
              'response',
              scriptResponse('http://127.0.0.1:9/src/app.js'),
            )
          },
          testInfo(),
        ),
      { bytesPerOperation: 256, iterations: 100 },
    )
    expect(measured.bytesPerOperation).toBeLessThan(256)
  })

  test('removes its listeners when the test body throws', async () => {
    const context = new FakeContext()
    const page = context.newPage()

    await expect(
      fixtureBody()(
        { page },
        async () => {
          throw new Error('test body failed')
        },
        testInfo(),
      ),
    ).rejects.toThrow('test body failed')

    expect(page.listenerCount('response')).toBe(0)
    expect(context.listenerCount('page')).toBe(0)
  })
})

describe('correlated evidence', () => {
  test('keeps only project files from the events it collects', async () => {
    const evidenceDirectory = join(root, '.tia/evidence')
    vi.stubEnv(TIA_EVIDENCE_DIRECTORY_ENV, evidenceDirectory)
    const context = new FakeContext()
    const page = context.newPage()
    const attachments: Attachment[] = []

    await fixtureBody()(
      { page },
      async () => {
        // An event written by another process, outside the evidence SDK.
        const id = await context.correlationId()
        const directory = join(
          evidenceDirectory,
          createHash('sha256').update(id).digest('hex'),
        )
        mkdirSync(directory, { recursive: true })
        writeFileSync(
          join(directory, '1.json'),
          JSON.stringify({
            correlationId: id,
            files: ['../../etc/passwd', '/outside.ts', 'src/server.ts', '.'],
            producedAt: 'now',
            producer: 'server',
            schema: 1,
          }),
        )
      },
      testInfo(attachments),
    )

    expect(JSON.parse(attachments[0]?.body.toString('utf8') ?? '')).toEqual([
      'src/server.ts',
    ])
  })
})
