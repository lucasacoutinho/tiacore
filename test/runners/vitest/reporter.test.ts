import { resolve } from 'node:path'

import { describe, expect, test, vi } from 'vitest'
import type { TestCase, TestModule } from 'vitest/node'

import type { TiaTestEdge } from '../../../src/core/runtime.ts'
import type { ModuleGraphLike } from '../../../src/runners/vitest/module-graph.ts'
import { normalizeOptions } from '../../../src/runners/vitest/options.ts'
import {
  TIA_META_KEY,
  TIA_TEST_META_KEY,
} from '../../../src/runners/vitest/protocol.ts'
import { TiaReporter } from '../../../src/runners/vitest/reporter.ts'
import { initialRuntime } from '../../../src/runners/vitest/state.ts'

const root = resolve('/project')
const path = (file: string) => resolve(root, file)

function makeModule(
  file: string,
  graph: ModuleGraphLike,
  concurrent = false,
): TestModule {
  const meta = {
    [TIA_META_KEY]: {
      collectionCoverage: {},
      collectionFiles: [path('test/setup.ts')],
      concurrent,
      files: [],
    },
  }
  return {
    moduleId: path(file),
    meta: () => meta,
    viteEnvironment: { moduleGraph: graph },
  } as unknown as TestModule
}

function recordCase(
  reporter: TiaReporter,
  module: TestModule,
  id: string,
  files: string[],
) {
  const meta = { [TIA_TEST_META_KEY]: { coverage: {}, files: files.map(path) } }
  reporter.onTestCaseResult({
    diagnostic: () => undefined,
    fullName: id,
    id,
    meta: () => meta,
    module,
    result: () => ({ state: 'passed' }),
  } as unknown as TestCase)
}

interface ReporterState {
  edges: Map<string, string[]>
  testEdges: Map<string, TiaTestEdge>
  testCoverage: Map<string, unknown>
  mergeModuleEvidence(): void
}

function state(reporter: TiaReporter): ReporterState {
  return reporter as unknown as ReporterState
}

function assetGraph(asset: string) {
  const source = {
    file: path('src/shared.ts'),
    id: path('src/shared.ts'),
    importedModules: new Set<{
      file: string
      id: string
      importedModules: Set<never>
    }>(),
  }
  source.importedModules.add({
    file: path(asset),
    id: path(asset),
    importedModules: new Set(),
  })
  const getModuleById = vi.fn<ModuleGraphLike['getModuleById']>((id) =>
    id === source.id ? source : undefined,
  )
  const graph: ModuleGraphLike = {
    getModuleById,
    getModulesByFile: () => undefined,
  }
  return { source, graph, getModuleById }
}

describe('Vitest reporter module evidence', () => {
  test('bounds the number of cached paths without dropping evidence', () => {
    const reporter = new TiaReporter(initialRuntime(normalizeOptions({}), root))
    const getModuleById = vi.fn<ModuleGraphLike['getModuleById']>((id) => ({
      file: id,
      id,
      importedModules: new Set(),
    }))
    const graph: ModuleGraphLike = {
      getModuleById,
      getModulesByFile: () => undefined,
    }
    const module = makeModule('test/many.test.ts', graph)
    for (let index = 0; index < 1_025; index += 1) {
      recordCase(reporter, module, String(index), [`src/dep-${index}.ts`])
    }
    recordCase(reporter, module, 'last-again', ['src/dep-1024.ts'])
    reporter.onTestModuleEnd(module)
    getModuleById.mockClear()
    state(reporter).mergeModuleEvidence()
    expect(getModuleById).toHaveBeenCalledTimes(1_026)
    expect(state(reporter).testEdges.get('last-again')?.files).toEqual([
      'src/dep-1024.ts',
      'test/many.test.ts',
      'test/setup.ts',
    ])
  })

  test('keeps test edges isolated, unions file edges and scopes reuse to graph and merge', () => {
    const reporter = new TiaReporter(initialRuntime(normalizeOptions({}), root))
    const a = assetGraph('assets/a.css')
    const b = assetGraph('assets/b.css')
    const first = makeModule('test/first.test.ts', a.graph)
    const second = makeModule('test/second.test.ts', b.graph)
    const concurrent = makeModule('test/concurrent.test.ts', a.graph, true)
    recordCase(reporter, first, 'first', ['src/shared.ts', 'src/only-first.ts'])
    recordCase(reporter, second, 'other-graph', ['src/shared.ts'])
    recordCase(reporter, concurrent, 'concurrent', ['src/shared.ts'])
    reporter.onTestModuleEnd(first)
    reporter.onTestModuleEnd(second)
    reporter.onTestModuleEnd(concurrent)
    // Vitest may deliver another case after its module, and its graph can gain assets before run end.
    recordCase(reporter, first, 'later', ['src/shared.ts'])
    a.source.importedModules.add({
      file: path('assets/late.css'),
      id: path('assets/late.css'),
      importedModules: new Set(),
    })
    a.getModuleById.mockClear()
    b.getModuleById.mockClear()

    state(reporter).mergeModuleEvidence()
    const edges = state(reporter).testEdges
    expect(edges.get('first')?.files).toEqual([
      'assets/a.css',
      'assets/late.css',
      'src/only-first.ts',
      'src/shared.ts',
      'test/first.test.ts',
      'test/setup.ts',
    ])
    expect(edges.get('later')?.files).toEqual([
      'assets/a.css',
      'assets/late.css',
      'src/shared.ts',
      'test/first.test.ts',
      'test/setup.ts',
    ])
    expect(edges.get('other-graph')?.files).toEqual([
      'assets/b.css',
      'src/shared.ts',
      'test/second.test.ts',
      'test/setup.ts',
    ])
    expect(edges.has('concurrent')).toBe(false)
    expect(state(reporter).testCoverage.has('concurrent')).toBe(false)
    expect(state(reporter).edges.get('test/first.test.ts')).toEqual([
      'assets/a.css',
      'assets/late.css',
      'test/first.test.ts',
    ])
    expect(
      a.getModuleById.mock.calls.filter(([id]) => id === path('src/shared.ts')),
    ).toHaveLength(1)
    expect(
      b.getModuleById.mock.calls.filter(([id]) => id === path('src/shared.ts')),
    ).toHaveLength(1)

    a.source.importedModules.add({
      file: path('assets/next.css'),
      id: path('assets/next.css'),
      importedModules: new Set(),
    })
    reporter.onTestModuleEnd(makeModule('test/first.test.ts', a.graph))
    state(reporter).mergeModuleEvidence()
    expect(state(reporter).testEdges.get('later')?.files).toContain(
      'assets/next.css',
    )
  })
})
