import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  cleanupProjects,
  createFixtureProject,
  runCommand,
} from './helpers/integration-project.js'

afterEach(cleanupProjects)

describe('Playwright adapter', () => {
  test('records browser source maps and reruns only the affected file', () => {
    const root = createFixtureProject('playwright-runtime')

    const record = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      30_000,
    )
    expect(record.status, record.output).toBe(0)
    expect(record.output).toContain('TIA record:')
    expect(
      existsSync(join(root, '.tia/playwright/graph.json')),
      record.output,
    ).toBe(true)
    expect(
      readFileSync(join(root, 'executions.log'), 'utf8')
        .trim()
        .split('\n')
        .sort(),
    ).toEqual(['lazy', 'shared'])
    const graph = JSON.parse(
      readFileSync(join(root, '.tia/playwright/graph.json'), 'utf8'),
    ) as {
      testEdges: Record<string, { file: string; files: string[] }>
    }
    const edges = Object.values(graph.testEdges)
    const lazyEdge = edges.find((edge) =>
      edge.file.endsWith('lazy.spec.ts'),
    )
    const sharedEdge = edges.find((edge) =>
      edge.file.endsWith('shared.spec.ts'),
    )
    expect(lazyEdge?.files).toContain('src/lazy.js')
    expect(sharedEdge?.files).not.toContain('src/lazy.js')

    writeFileSync(join(root, 'executions.log'), '')
    const replay = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      30_000,
    )
    expect(replay.status, replay.output).toBe(0)
    expect(replay.output).toContain('TIA replay: 0 affected files, 2 cached tests.')
    expect(readFileSync(join(root, 'executions.log'), 'utf8')).toBe('')

    appendFileSync(
      join(root, 'src/lazy.js'),
      '\ndocument.body.dataset.lazyRevision = "two"\n',
    )
    const affected = runCommand(
      root,
      process.execPath,
      ['run-tia.mjs'],
      30_000,
    )
    expect(affected.status, affected.output).toBe(0)
    expect(affected.output).toContain('TIA replay: 1 affected file, 1 cached test.')
    expect(
      readFileSync(join(root, 'executions.log'), 'utf8'),
      affected.output,
    ).toBe('lazy\n')
  }, 90_000)
})
