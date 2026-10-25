import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, test } from 'vitest'

import {
  CHROMIUM_MISSING,
  chromiumInstalled,
  cleanupProjects,
  disposeGraphReader,
  fixtureProject,
  runNode,
  storedGraph,
} from '../runners/support/playwright-project.ts'

// The Playwright runner against a real browser. It joins the normal suite
// whenever Chromium is installed; without it the suite reports one skipped
// test that says how to install it.

afterEach(cleanupProjects)
afterAll(disposeGraphReader)

const installed = chromiumInstalled()
test.runIf(!installed)('Playwright runner against Chromium', ({ skip }) => {
  expect(installed).toBe(false)
  skip(CHROMIUM_MISSING)
})

const PLAIN_SPEC = `import { test } from '@playwright/test'

test('uses the plain test', async () => {})
`

function executions(root: string): string[] {
  const path = join(root, 'executions.log')
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).sort()
    : []
}

function reset(root: string): void {
  writeFileSync(join(root, 'executions.log'), '')
}

const runTia = (
  root: string,
  args: string[] = [],
  environment: Record<string, string> = {},
) => runNode(root, ['run-tia.mjs', ...args], environment, 90_000)

describe.skipIf(!installed)('Playwright adapter', () => {
  test('records browser source maps and reruns only the affected file', async () => {
    const root = fixtureProject('playwright-runtime')

    const record = runTia(root)
    expect(record.status, record.output).toBe(0)
    expect(record.output).toContain('TIA record:')
    expect(existsSync(join(root, '.tia/playwright/state.json'))).toBe(true)
    expect(executions(root)).toEqual(['lazy', 'shared'])
    const graph = await storedGraph(root)
    if (graph === null) throw new Error('expected a Playwright graph')
    // A file-level runner commits a complete graph and no coverage.
    expect(graph.complete).toBe(true)
    expect(graph.coverageComplete).toBe(false)
    const edges = Object.values(graph.testEdges)
    const lazyEdge = edges.find((edge) => edge.file.endsWith('lazy.spec.ts'))
    const sharedEdge = edges.find((edge) =>
      edge.file.endsWith('shared.spec.ts'),
    )
    expect(lazyEdge?.files).toContain('src/lazy.js')
    expect(lazyEdge?.files).toContain('backend/lazy-route.ts')
    expect(sharedEdge?.files).not.toContain('src/lazy.js')
    expect(sharedEdge?.files).not.toContain('backend/lazy-route.ts')
    // The session file is removed once the run ends.
    expect(readdirSync(join(root, '.tia/runtime'))).toEqual([])
  }, 120_000)

  test('replays nothing when nothing changed, then reruns what a source change reaches', () => {
    const root = fixtureProject('playwright-runtime')
    expect(runTia(root).status).toBe(0)

    reset(root)
    const replay = runTia(root)
    expect(replay.status, replay.output).toBe(0)
    expect(replay.output).toContain(
      'TIA replay: 0 affected files, 2 cached tests.',
    )
    expect(executions(root)).toEqual([])

    appendFileSync(
      join(root, 'src/lazy.js'),
      '\ndocument.body.dataset.lazyRevision = "two"\n',
    )
    const affected = runTia(root)
    expect(affected.status, affected.output).toBe(0)
    expect(affected.output).toContain(
      'TIA replay: 1 affected file, 1 cached test.',
    )
    expect(executions(root), affected.output).toEqual(['lazy'])

    reset(root)
    appendFileSync(
      join(root, 'backend/lazy-route.ts'),
      '\nexport const lazyRouteRevision = "two"\n',
    )
    const backend = runTia(root)
    expect(backend.status, backend.output).toBe(0)
    expect(backend.output).toContain(
      'TIA replay: 1 affected file, 1 cached test.',
    )
    expect(executions(root), backend.output).toEqual(['lazy'])
  }, 180_000)

  test('records a failed affected spec and forces it to rerun', async () => {
    const root = fixtureProject('playwright-runtime')
    const baseline = runTia(root)
    expect(baseline.status, baseline.output).toBe(0)
    reset(root)
    appendFileSync(join(root, 'src/lazy.js'), '\n// failing revision\n')

    const failed = runTia(root, [], { TIACORE_PLAYWRIGHT_FAIL: '1' })
    expect(failed.status).toBe(1)
    expect(executions(root)).toEqual(['lazy'])
    expect(Object.values((await storedGraph(root))?.results ?? {})).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'failed' })]),
    )

    reset(root)
    const recovered = runTia(root)
    expect(recovered.status, recovered.output).toBe(0)
    expect(executions(root)).toEqual(['lazy'])
    expect(recovered.output).toContain('previous test failed')
  }, 180_000)

  test('a spec built from the plain test blocks the commit and says why', async () => {
    const root = fixtureProject('playwright-runtime')
    writeFileSync(join(root, 'test/plain.spec.ts'), PLAIN_SPEC)

    const run = runTia(root)
    expect(run.status, run.output).toBe(0)
    expect(run.output).toContain(
      'TIA graph was not updated because Playwright dependency evidence was incomplete.',
    )
    expect(run.output).toContain('TIA detail: no dependency evidence from')
    expect(run.output).toContain('test/plain.spec.ts')
    expect(run.output).toContain('notes: no dependency evidence from')
    expect(await storedGraph(root)).toBeNull()
  }, 120_000)

  test('a run that stops early leaves the graph alone and counts the missing tests', async () => {
    const root = fixtureProject('playwright-runtime')
    const run = runTia(root, ['--workers=1', '--max-failures=1'], {
      TIACORE_PLAYWRIGHT_FAIL: '1',
    })
    expect(run.status).toBe(1)
    expect(run.output).toContain(
      'TIA graph was not updated because Playwright dependency evidence was incomplete.',
    )
    expect(run.output).toMatch(
      /1 configured test produced no result inside .*the run stopped early/u,
    )
    expect(await storedGraph(root)).toBeNull()
  }, 120_000)

  test('a deleted spec is neither rerun nor counted as cached', () => {
    const root = fixtureProject('playwright-runtime')
    expect(runTia(root).status).toBe(0)

    reset(root)
    rmSync(join(root, 'test/lazy.spec.ts'))
    const run = runTia(root)
    expect(run.status, run.output).toBe(0)
    expect(run.output).toContain('TIA replay: 0 affected files, 1 cached test.')
    expect(executions(root)).toEqual([])
  }, 120_000)

  test('run arguments belong to the graph fingerprint', () => {
    const root = fixtureProject('playwright-runtime')
    expect(runTia(root).status).toBe(0)

    const changed = runTia(root, ['--workers=1'])
    expect(changed.status, changed.output).toBe(0)
    expect(changed.output).toContain('TIA record: project structure changed.')
  }, 120_000)

  test('a named lane keeps its graph in its own directory', () => {
    const root = fixtureProject('playwright-runtime')
    const run = runTia(root, [], { TIA_FIXTURE_NAME: 'QA Suite' })
    expect(run.status, run.output).toBe(0)
    expect(existsSync(join(root, '.tia/playwright-qa-suite/state.json'))).toBe(
      true,
    )
    expect(existsSync(join(root, '.tia/playwright/state.json'))).toBe(false)
  }, 120_000)

  test('the fixture attaches nothing outside a tiacore run', () => {
    const root = fixtureProject('playwright-runtime')
    writeFileSync(
      join(root, 'test/inert.spec.ts'),
      `import { expect, test } from './fixture'

test('inert page', async ({ page }) => {
  await page.setContent('<p id="x">inert</p>')
  await expect(page.locator('#x')).toHaveText('inert')
})
`,
    )
    const run = runNode(
      root,
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        '--reporter=json',
        '--grep',
        'inert page',
      ],
      {},
      90_000,
    )
    expect(run.status, run.output).toBe(0)
    expect(run.output).not.toContain('tiacore.dependencies.json')
    expect(existsSync(join(root, '.tia'))).toBe(false)
  }, 120_000)
})
