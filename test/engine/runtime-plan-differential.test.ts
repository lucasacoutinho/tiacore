import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'
import { afterAll } from 'vitest'

import type { RunPlan, TiaRuntimeGraph } from '../../src/core/runtime.ts'
import {
  gateRuntimePlan,
  planRuntimeChanges,
  TEST_FILE_PATTERN,
} from '../../src/engine/plan/runtime.ts'
import { legacy } from '../support/legacy.ts'

const { createRunPlan } = await legacy<{
  createRunPlan: (input: unknown) => RunPlan
}>('engine/planning/runtime.js')
const { captureBaseline, changedFilesSince } = await legacy<{
  captureBaseline: (
    root: string,
    ignored: string,
  ) => TiaRuntimeGraph['baseline'] | null
  changedFilesSince: (
    root: string,
    baseline: unknown,
    ignored: string,
  ) => string[] | null
}>('engine/baseline/capture.js')

const TEST_FILES = ['t/a.test.ts', 't/b.test.ts', '__tests__/helper.ts']
const SOURCES = ['src/x.ts', 'src/y.ts', '__tests__/helper.ts']
const FILES = [
  ...TEST_FILES,
  'src/x.ts',
  'src/y.ts',
  'package.json',
  'docs/new.md',
]
const CASES = [
  ['a1', 't/a.test.ts'],
  ['a2', 't/a.test.ts'],
  ['b1', 't/b.test.ts'],
] as const

const flag = Arbitrary.schema(Schema.Boolean)
const subset = <T>(values: readonly T[]) =>
  Arbitrary.all(values.map(() => flag)).pipe(
    Arbitrary.map((flags) => values.filter((_, index) => flags[index])),
  )
const scenario = Arbitrary.all({
  changed: subset(FILES),
  edges: Arbitrary.all(TEST_FILES.slice(0, 2).map(() => subset(SOURCES))),
  existing: subset(FILES),
  ignoreUnknown: flag,
  results: Arbitrary.all(
    CASES.map(() =>
      Arbitrary.all({
        hasEdge: Arbitrary.schema(Schema.Literals([true, true, true, false])),
        state: Arbitrary.schema(
          Schema.Literals(['passed', 'passed', 'failed', 'skipped']),
        ),
      }),
    ),
  ),
  moduleFailure: Arbitrary.schema(Schema.Literals([false, false, false, true])),
})

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function project(existing: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-runtime-plan-'))
  roots.push(root)
  for (const file of existing) {
    mkdirSync(join(root, dirname(file)), { recursive: true })
    writeFileSync(join(root, file), `// ${file}\n`)
  }
  return root
}

// 1.x listed linked test files that no longer exist as whole-file fallbacks and
// replayed results of unlinked deleted files. 2.0 drops results of missing files
// (ADR 0004 row REPLAY-DELETED), so both plans are compared on existing files.
function selection(
  plan: RunPlan,
  graph: TiaRuntimeGraph,
  exists: (file: string) => boolean,
) {
  const whole = plan.wholeTestFiles.filter(exists)
  const affected = new Set(plan.affectedTestIds)
  return {
    affectedTestIds: [...plan.affectedTestIds].sort(),
    affectedTests: [...plan.affectedTests].sort(),
    decisions: plan.decisions
      .filter((decision) => decision.target === 'run' || exists(decision.file))
      .map((decision) =>
        JSON.stringify({ ...decision, reasons: [...decision.reasons].sort() }),
      )
      .sort(),
    mode: plan.mode,
    replayed:
      plan.mode === 'record'
        ? 0
        : Object.values(graph.results).filter(
            (result) =>
              exists(result.file) &&
              result.state !== 'failed' &&
              !affected.has(result.id) &&
              !whole.includes(result.file),
          ).length,
    wholeTestFiles: whole.sort(),
  }
}

describe('runtime planning', () => {
  it.prop(
    'matches 1.x, selecting more only for imported test-pattern files',
    [scenario],
    ([input]) => {
      const root = project(input.existing)
      const captured = captureBaseline(root, '.tia')
      if (captured === null) throw new Error('expected a filesystem baseline')
      const workingTree = { ...captured.workingTree }
      for (const file of input.changed)
        workingTree[file] = 'changed-since-baseline'
      const baseline = { ...captured, workingTree }
      const edges = Object.fromEntries(
        TEST_FILES.slice(0, 2).map((file, index) => [
          file,
          [...(input.edges[index] ?? []), file],
        ]),
      )
      const graph: TiaRuntimeGraph = {
        baseline,
        collectionCoverage: {},
        collectionFiles: {},
        complete: true,
        coverageComplete: true,
        coverageMaps: {},
        edges,
        fingerprint: 'fp',
        results: Object.fromEntries([
          ...CASES.map(([id, file], index) => [
            id,
            {
              file,
              fullName: id,
              id,
              state: input.results[index]?.state ?? 'passed',
            },
          ]),
          ...(input.moduleFailure
            ? [
                [
                  'module:t/b.test.ts',
                  {
                    file: 't/b.test.ts',
                    fullName: 'module',
                    id: 'module:t/b.test.ts',
                    state: 'failed',
                  },
                ],
              ]
            : []),
        ]),
        schema: 5,
        testCoverage: {},
        testEdges: Object.fromEntries(
          CASES.filter(
            (_, index) => input.results[index]?.hasEdge !== false,
          ).map(([id, file]) => [
            id,
            {
              file,
              files: (edges[file] ?? []).filter(
                (_, i) => (i + id.length) % 2 === 0 || i === 0,
              ),
            },
          ]),
        ),
        updatedAt: '2026-10-25T00:00:00.000Z',
      }
      const options = {
        fresh: false,
        ignoreChanges: input.ignoreUnknown ? ['docs/**'] : [],
        onUnknownChange: 'full' as const,
      }
      const planInput = {
        baseline: {
          origin: 'local' as const,
          reason: 'local graph loaded',
          sha: null,
          source: 'filesystem' as const,
        },
        fingerprint: 'fp',
        graph,
        options,
      }
      const expected = createRunPlan({
        ...planInput,
        cachePrefix: '.tia',
        ignoredPrefixes: ['.tia'],
        root,
      })
      const changes = changedFilesSince(root, baseline, '.tia')
      expect(changes).not.toBeNull()
      const exists = (file: string) => existsSync(join(root, file))
      const actual =
        gateRuntimePlan(planInput) ??
        planRuntimeChanges(planInput, changes ?? [], exists)
      expect(actual.replayedTests).toBe(
        selection(actual, graph, exists).replayed,
      )

      const importedTestFileChanged = (changes ?? []).some(
        (file) =>
          TEST_FILE_PATTERN.test(file) &&
          Object.entries(edges).some(
            ([owner, sources]) => owner !== file && sources.includes(file),
          ),
      )
      if (!importedTestFileChanged) {
        expect(selection(actual, graph, exists)).toEqual(
          selection(expected, graph, exists),
        )
        return
      }
      for (const id of expected.affectedTestIds) {
        const file = graph.testEdges[id]?.file ?? ''
        expect(
          actual.affectedTestIds.includes(id) ||
            actual.wholeTestFiles.includes(file),
        ).toBe(true)
      }
      for (const file of expected.wholeTestFiles.filter(exists))
        expect(actual.wholeTestFiles).toContain(file)
    },
    { arbitrary: { runs: 300 } },
  )
})
