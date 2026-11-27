import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import type {
  TiaCoverageRecord,
  TiaRuntimeGraph,
} from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import { GraphStoreLive } from '../../../src/engine/state/graph-store.ts'
import { updateGraph } from '../../../src/engine/state/update.ts'
import { versus } from '../../support/bench-report.ts'
import {
  LARGE_GRAPH,
  legacyLayout,
  oneTestReran,
  runtimeGraph,
  testFileName,
  type LegacyRuntimeGraph,
} from '../../support/bench-graph.ts'
import {
  bothVersionsAsync,
  timed,
  timedAsync,
} from '../../support/bench-run.ts'
import { legacy } from '../../support/legacy.ts'
import type { Workload } from './workload.ts'

interface LegacyStore {
  commitGraph: (
    cacheDir: string,
    options: {
      expected: LegacyRuntimeGraph | null
      expectedDigest: string | null
      graph: LegacyRuntimeGraph
    },
  ) => Promise<{ graph: unknown; status: string }>
  graphDigest: (graph: LegacyRuntimeGraph | null) => string | null
  readGraph: (cacheDir: string) => LegacyRuntimeGraph | null
}

interface LegacyUpdate {
  updateGraph: (input: {
    collectionCoverage: ReadonlyMap<string, TiaCoverageRecord>
    executedFiles: readonly string[]
    fullyExecutedFiles: readonly string[]
    previous: LegacyRuntimeGraph
    results: ReadonlyMap<string, unknown>
    root: string
    testCoverage: ReadonlyMap<string, TiaCoverageRecord>
    testEdges: ReadonlyMap<string, unknown>
  }) => LegacyRuntimeGraph
}

interface Timings {
  commitFull: number
  commitSmall: number
  read: number
  update: number
}

const makeRuntime = () =>
  ManagedRuntime.make(
    GraphStoreLive.pipe(Layer.provideMerge(NodeServices.layer)),
  )

interface State {
  readonly current: TiaRuntimeGraph
  readonly old: LegacyRuntimeGraph
  readonly oldStore: LegacyStore
  readonly oldUpdate: LegacyUpdate
  /** A project holding the graph's test files, which both updates check. */
  readonly root: string
  readonly runtime: ReturnType<typeof makeRuntime>
}

const UPDATED_AT = '2026-01-02T00:00:00.000Z'

let state: State | undefined
const directories: string[] = []

function fresh(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tiacore-bench-store-'))
  directories.push(directory)
  return directory
}

/** A collection pending from the previous operation would land in this one. */
function settle(): void {
  globalThis.gc?.()
}

async function currentStore(inputs: State): Promise<Timings> {
  const directory = fresh()
  const run = <A>(
    effect: Effect.Effect<
      A,
      unknown,
      ManagedRuntime.ManagedRuntime.Services<State['runtime']>
    >,
  ) => inputs.runtime.runPromise(effect)
  settle()
  const full = await timedAsync(() =>
    run(
      Effect.flatMap(GraphStore, (store) =>
        store.commit(directory, {
          expected: null,
          expectedDigest: null,
          graph: inputs.current,
        }),
      ),
    ),
  )
  if (full.value.status !== 'committed') {
    throw new Error(`the first commit was ${full.value.status}`)
  }
  settle()
  const read = await timedAsync(() =>
    run(Effect.flatMap(GraphStore, (store) => store.read(directory))),
  )
  const stored = read.value
  if (stored.graph === null) throw new Error('the store read no graph')
  const previous = stored.graph
  const rerun = oneTestReran(previous, LARGE_GRAPH)
  const collection = structuredClone(
    previous.collectionCoverage[rerun.file] ?? {},
  )
  settle()
  const update = await timedAsync(() =>
    run(
      updateGraph({
        collectionCoverage: new Map([[rerun.file, collection]]),
        collectionFiles: new Map([
          [rerun.file, [...(previous.collectionFiles[rerun.file] ?? [])]],
        ]),
        executedFiles: [rerun.file],
        fullyExecutedFiles: [],
        header: {
          baseline: structuredClone(previous.baseline),
          complete: true,
          coverageComplete: true,
          fingerprint: previous.fingerprint,
          partition: null,
          updatedAt: UPDATED_AT,
        },
        presentFiles: [rerun.file],
        previous,
        results: new Map([[rerun.id, rerun.result]]),
        root: inputs.root,
        testCoverage: new Map([[rerun.id, rerun.coverage]]),
        testEdges: new Map([[rerun.id, rerun.edge]]),
      }),
    ),
  )
  settle()
  const small = await timedAsync(() =>
    run(
      Effect.flatMap(GraphStore, (store) =>
        store.commit(directory, {
          expected: previous,
          expectedDigest: stored.digest,
          graph: update.value,
        }),
      ),
    ),
  )
  if (small.value.status !== 'committed') {
    throw new Error(`the small commit was ${small.value.status}`)
  }
  return {
    commitFull: full.ms,
    commitSmall: small.ms,
    read: read.ms,
    update: update.ms,
  }
}

async function legacyStore(inputs: State): Promise<Timings> {
  const directory = fresh()
  const { commitGraph, graphDigest, readGraph } = inputs.oldStore
  settle()
  const full = await timedAsync(() =>
    commitGraph(directory, {
      expected: null,
      expectedDigest: null,
      graph: inputs.old,
    }),
  )
  if (full.value.status !== 'committed') {
    throw new Error(`the first 1.x commit was ${full.value.status}`)
  }
  settle()
  // 1.x keeps the digest apart from the read; the engine takes both at once.
  const read = await timedAsync(async () => {
    const graph = readGraph(directory)
    return { digest: graphDigest(graph), graph }
  })
  const stored = read.value
  if (stored.graph === null) throw new Error('1.x read no graph')
  const previous = stored.graph
  const rerun = oneTestReran(previous, LARGE_GRAPH)
  const collection = structuredClone(
    previous.collectionCoverage[rerun.file] ?? {},
  )
  const baseline = structuredClone(previous.baseline)
  settle()
  // 1.x's engine stamps the baseline and the time on the updated graph.
  const update = timed(() => ({
    ...inputs.oldUpdate.updateGraph({
      collectionCoverage: new Map([[rerun.file, collection]]),
      executedFiles: [rerun.file],
      fullyExecutedFiles: [],
      previous,
      results: new Map([[rerun.id, rerun.result]]),
      root: inputs.root,
      testCoverage: new Map([[rerun.id, rerun.coverage]]),
      testEdges: new Map([[rerun.id, rerun.edge]]),
    }),
    baseline,
    updatedAt: UPDATED_AT,
  }))
  settle()
  const small = await timedAsync(() =>
    commitGraph(directory, {
      expected: previous,
      expectedDigest: stored.digest,
      graph: update.value,
    }),
  )
  if (small.value.status !== 'committed') {
    throw new Error(`the small 1.x commit was ${small.value.status}`)
  }
  return {
    commitFull: full.ms,
    commitSmall: small.ms,
    read: read.ms,
    update: update.ms,
  }
}

/** A project directory with every test file of the graph, all empty. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-bench-project-'))
  for (let index = 0; index < LARGE_GRAPH.testFiles; index += 1) {
    const path = join(root, testFileName(index))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
  return root
}

/**
 * The graph store on a large runtime graph, in-process: a first commit of the
 * whole graph, a cold read of it back, the update of the read graph with one
 * rerun test (its result, coverage and file's collection) and the commit of
 * that update. 1.x's read includes its digest, which its engine takes right
 * after reading.
 */
export const store: Workload = {
  name: 'store',
  async round(index) {
    if (state === undefined) throw new Error('store ran before its setup')
    const inputs = state
    const timings = await bothVersionsAsync(index, (version) =>
      version === 'current' ? currentStore(inputs) : legacyStore(inputs),
    )
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
    return {
      ...versus(
        'commit-full',
        timings.current.commitFull,
        timings.legacy.commitFull,
      ),
      ...versus('read', timings.current.read, timings.legacy.read),
      ...versus('update', timings.current.update, timings.legacy.update),
      ...versus(
        'commit-small',
        timings.current.commitSmall,
        timings.legacy.commitSmall,
      ),
    }
  },
  async setup() {
    const current = runtimeGraph(LARGE_GRAPH)
    state = {
      current,
      old: legacyLayout(current),
      oldStore: await legacy<LegacyStore>('engine/state/store.js'),
      oldUpdate: await legacy<LegacyUpdate>('engine/state/update.js'),
      root: project(),
      runtime: makeRuntime(),
    }
  },
  summary: `GraphStore commit, read, one-test update and small commit on a runtime graph of ${LARGE_GRAPH.tests} tests with per-test coverage, in-process, on disk`,
  async teardown() {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
    if (state !== undefined) {
      rmSync(state.root, { force: true, recursive: true })
    }
    await state?.runtime.dispose()
    state = undefined
  },
  warmup: 1,
}
