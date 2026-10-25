import { describe, expect, test } from 'vitest'

import type { RunPlan, TiaRuntimeGraph } from '../../src/core/runtime.ts'
import {
  configuredRunnerName,
  runnerName,
} from '../../src/runners/playwright/names.ts'
import {
  MAX_FILTER_CHARACTERS,
  cachedTestCount,
  planFilters,
} from '../../src/runners/playwright/program.ts'
import {
  evidenceProblems,
  readReport,
} from '../../src/runners/playwright/report.ts'
import type { PlaywrightRunReport } from '../../src/runners/playwright/protocol.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('lane names', () => {
  test.each([
    ['playwright.config.ts', 'playwright'],
    ['playwright.config.js', 'playwright'],
    ['playwright.config.mts', 'playwright'],
    ['playwright.qa.config.ts', 'playwright-qa'],
    ['playwright.Smoke Tests.config.ts', 'playwright-smoke-tests'],
    ['playwright.ts', 'playwright'],
    ['e2e.config.ts', 'playwright-e2e'],
    ['config.ts', 'playwright'],
    ['custom.cjs', 'playwright-custom'],
    ['--.config.ts', 'playwright'],
  ])('derives %s as %s', (config, expected) => {
    expect(runnerName(config)).toBe(expected)
    expect(configuredRunnerName(config, undefined)).toBe(expected)
  })

  test.each([
    ['qa', 'playwright-qa'],
    ['QA Suite', 'playwright-qa-suite'],
    ['playwright', 'playwright'],
    ['playwright-nightly', 'playwright-nightly'],
    ['--Release 1.2--', 'playwright-release-1-2'],
    ['Playwright', 'playwright'],
  ])('sanitizes the explicit name %s as %s', (name, expected) => {
    expect(configuredRunnerName('playwright.config.ts', name)).toBe(expected)
  })

  test.each(['', '---', '   ', '!!'])(
    'rejects the name %j with no letter or number',
    (name) => {
      expect(() => configuredRunnerName('playwright.config.ts', name)).toThrow(
        'Playwright TIA name must contain a letter or number.',
      )
    },
  )
})

function plan(overrides: Partial<RunPlan>): RunPlan {
  return {
    affectedTestIds: [],
    affectedTests: [],
    baseline: { origin: 'none', reason: 'test', sha: null, source: null },
    changedFiles: [],
    decisions: [],
    graph: null,
    mode: 'replay',
    reason: 'test',
    replayedTests: 0,
    wholeTestFiles: [],
    ...overrides,
  }
}

describe('path filters', () => {
  test('a record passes no filters', () => {
    expect(
      planFilters(plan({ affectedTests: ['a.spec.ts'], mode: 'record' }), '/p'),
    ).toEqual({ filters: [] })
  })

  test('a replay passes one escaped absolute path per affected spec', () => {
    expect(
      planFilters(
        plan({ affectedTests: ['e2e/a.spec.ts', 'e2e/(b)+c.spec.ts'] }),
        '/project',
      ),
    ).toEqual({
      filters: [
        '/project/e2e/a\\.spec\\.ts',
        '/project/e2e/\\(b\\)\\+c\\.spec\\.ts',
      ],
    })
  })

  test('a list over the limit becomes a full run that says why', () => {
    const affectedTests = Array.from(
      { length: 400 },
      (_, index) =>
        `e2e/${'long-directory-name/'.repeat(2)}spec-${index}.spec.ts`,
    )
    const selected = planFilters(plan({ affectedTests }), '/project')
    expect(selected.filters).toEqual([])
    expect(selected.note).toBe(
      `the 400 affected spec paths exceed ${MAX_FILTER_CHARACTERS} characters, so Playwright runs every spec`,
    )
  })

  test('a list exactly at the limit is still passed on', () => {
    // '/p/' plus the escaped name: pad the name so the total is the limit.
    const name = `${'x'.repeat(MAX_FILTER_CHARACTERS - '/p/'.length - '\\.ts'.length)}.ts`
    const selected = planFilters(plan({ affectedTests: [name] }), '/p')
    expect(selected.filters.join('')).toHaveLength(MAX_FILTER_CHARACTERS)
    expect(selected.note).toBeUndefined()
  })
})

const result = (id: string, file: string, state: 'failed' | 'passed') => ({
  file,
  fullName: id,
  id,
  state,
})

const report = (overrides: Partial<PlaywrightRunReport> = {}) => ({
  configuredTestIds: ['t1'],
  observations: [
    {
      dependenciesComplete: true,
      file: 'a.spec.ts',
      files: [],
      fullName: 'a',
      id: 'playwright:t1',
      state: 'passed' as const,
    },
  ],
  status: 'passed' as const,
  ...overrides,
})

const graph = (results: ReturnType<typeof result>[]): TiaRuntimeGraph => ({
  baseline: { sha: '', workingTree: {} },
  collectionCoverage: {},
  collectionFiles: {},
  complete: true,
  coverageComplete: false,
  coverageMaps: {},
  edges: {},
  fingerprint: '',
  results: Object.fromEntries(results.map((entry) => [entry.id, entry])),
  schema: 5,
  testCoverage: {},
  testEdges: {},
  updatedAt: '',
})

describe('cached test count', () => {
  test('siblings of an affected test rerun with its spec file, so they are not cached', () => {
    const subject = plan({
      affectedTestIds: ['a1'],
      affectedTests: ['a.spec.ts'],
      graph: graph([
        result('a1', 'a.spec.ts', 'passed'),
        result('a2', 'a.spec.ts', 'passed'),
        result('b1', 'b.spec.ts', 'passed'),
        result('c1', 'c.spec.ts', 'failed'),
      ]),
      replayedTests: 3,
    })
    // The planner counts a2 and b1; only b1 is not rerun by Playwright.
    expect(subject.replayedTests).toBe(3)
    expect(cachedTestCount(subject)).toBe(1)
  })

  test('is zero for a record and counts everything when nothing is affected', () => {
    const results = [
      result('a1', 'a.spec.ts', 'passed'),
      result('b1', 'b.spec.ts', 'passed'),
    ]
    expect(
      cachedTestCount(plan({ graph: graph(results), mode: 'record' })),
    ).toBe(0)
    expect(cachedTestCount(plan({ graph: graph(results) }))).toBe(2)
  })
})

describe('session report', () => {
  test('a complete report has no problems', () => {
    expect(evidenceProblems(report(), '/p')).toEqual([])
  })

  test('a missing report blocks the commit', () => {
    expect(evidenceProblems(null, '/p')).toEqual([
      expect.stringContaining('Playwright wrote no report'),
    ])
  })

  test.each(['interrupted', 'timedout'] as const)(
    'a %s run blocks the commit',
    (status) => {
      expect(evidenceProblems(report({ status }), '/p')).toEqual([
        `the Playwright run was ${status}`,
      ])
    },
  )

  test('a failed run still commits', () => {
    expect(evidenceProblems(report({ status: 'failed' }), '/p')).toEqual([])
  })

  test('a spec without evidence is named once', () => {
    const base = report()
    const entry = base.observations[0]
    if (entry === undefined) throw new Error('fixture')
    const problems = evidenceProblems(
      report({
        configuredTestIds: ['t1', 't2'],
        observations: [
          { ...entry, dependenciesComplete: false },
          { ...entry, dependenciesComplete: false, id: 'playwright:t2' },
        ],
      }),
      '/p',
    )
    expect(problems).toEqual([
      expect.stringMatching(/^no dependency evidence from a\.spec\.ts; /u),
    ])
  })

  test('a configured test with no result blocks the commit and is counted', () => {
    expect(
      evidenceProblems(report({ configuredTestIds: ['t1', 't2', 't3'] }), '/p'),
    ).toEqual([
      expect.stringMatching(/^2 configured tests produced no result/u),
    ])
    expect(
      evidenceProblems(report({ configuredTestIds: ['t1', 't2'] }), '/p'),
    ).toEqual([expect.stringMatching(/^1 configured test produced no result/u)])
  })

  test('reads only well-formed reports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tiacore-playwright-report-'))
    try {
      const path = join(directory, 'report.json')
      expect(readReport(path)).toBeNull()
      writeFileSync(path, 'not json')
      expect(readReport(path)).toBeNull()
      writeFileSync(path, JSON.stringify({ observations: [] }))
      expect(readReport(path)).toBeNull()
      writeFileSync(path, `${JSON.stringify(report())}\n`)
      expect(readReport(path)).toEqual(report())
      writeFileSync(
        path,
        JSON.stringify(report({ status: 'exploded' as 'failed' })),
      )
      expect(readReport(path)).toBeNull()
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
