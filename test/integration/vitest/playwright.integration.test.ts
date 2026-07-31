import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { readGraph } from '../../../src/engine/state/store.js'

import {
  cleanupProjects,
  createFixtureProject,
  runCommand,
} from '../../helpers/integration-project.js'

afterEach(cleanupProjects)

describe('Playwright adapter', () => {
  test('records browser source maps and reruns only the affected file', () => {
    const root = createFixtureProject('playwright-runtime')

    const record = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000)
    expect(record.status, record.output).toBe(0)
    expect(record.output).toContain('TIA record:')
    expect(
      existsSync(join(root, '.tia/playwright/state.json')),
      record.output,
    ).toBe(true)
    expect(
      readFileSync(join(root, 'executions.log'), 'utf8')
        .trim()
        .split('\n')
        .sort(),
    ).toEqual(['lazy', 'shared'])
    const graph = readGraph(join(root, '.tia/playwright'))
    if (graph === null) throw new Error('expected Playwright graph')
    const edges = Object.values(graph.testEdges)
    const lazyEdge = edges.find((edge) => edge.file.endsWith('lazy.spec.ts'))
    const sharedEdge = edges.find((edge) =>
      edge.file.endsWith('shared.spec.ts'),
    )
    expect(lazyEdge?.files).toContain('src/lazy.js')
    expect(lazyEdge?.files).toContain('backend/lazy-route.ts')
    expect(sharedEdge?.files).not.toContain('src/lazy.js')
    expect(sharedEdge?.files).not.toContain('backend/lazy-route.ts')

    writeFileSync(join(root, 'executions.log'), '')
    const replay = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000)
    expect(replay.status, replay.output).toBe(0)
    expect(replay.output).toContain(
      'TIA replay: 0 affected files, 2 cached tests.',
    )
    expect(readFileSync(join(root, 'executions.log'), 'utf8')).toBe('')

    appendFileSync(
      join(root, 'src/lazy.js'),
      '\ndocument.body.dataset.lazyRevision = "two"\n',
    )
    const affected = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000)
    expect(affected.status, affected.output).toBe(0)
    expect(affected.output).toContain(
      'TIA replay: 1 affected file, 1 cached test.',
    )
    expect(
      readFileSync(join(root, 'executions.log'), 'utf8'),
      affected.output,
    ).toBe('lazy\n')

    writeFileSync(join(root, 'executions.log'), '')
    appendFileSync(
      join(root, 'backend/lazy-route.ts'),
      '\nexport const lazyRouteRevision = "two"\n',
    )
    const backendAffected = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      30_000,
    )
    expect(backendAffected.status, backendAffected.output).toBe(0)
    expect(backendAffected.output).toContain(
      'TIA replay: 1 affected file, 1 cached test.',
    )
    expect(
      readFileSync(join(root, 'executions.log'), 'utf8'),
      backendAffected.output,
    ).toBe('lazy\n')
  }, 90_000)

  test('records a failed affected spec and forces it to rerun', () => {
    const root = createFixtureProject('playwright-runtime')
    const baseline = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000)
    expect(baseline.status, baseline.output).toBe(0)
    writeFileSync(join(root, 'executions.log'), '')
    appendFileSync(join(root, 'src/lazy.js'), '\n// failing revision\n')

    const failed = runCommand(root, process.execPath, ['run-tia.mjs'], 30_000, {
      TIACORE_PLAYWRIGHT_FAIL: '1',
    })
    expect(failed.status).toBe(1)
    expect(readFileSync(join(root, 'executions.log'), 'utf8')).toBe('lazy\n')
    expect(
      Object.values(readGraph(join(root, '.tia/playwright'))?.results ?? {}),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'failed' })]),
    )

    writeFileSync(join(root, 'executions.log'), '')
    const recovered = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      30_000,
    )
    expect(recovered.status, recovered.output).toBe(0)
    expect(readFileSync(join(root, 'executions.log'), 'utf8')).toBe('lazy\n')
    expect(recovered.output).toContain('previous test failed')
  }, 90_000)
})
