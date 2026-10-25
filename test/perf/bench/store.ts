import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { GraphStore } from '../../../src/engine/ports.ts'
import { GraphStoreLive } from '../../../src/engine/state/graph-store.ts'
import { versus } from '../../support/bench-report.ts'
import {
  afterOneTestReran,
  LARGE_GRAPH,
  legacyLayout,
  runtimeGraph,
  type LegacyRuntimeGraph,
} from '../../support/bench-graph.ts'
import { bothVersionsAsync, timedAsync } from '../../support/bench-run.ts'
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

interface Timings {
  commitFull: number
  commitSmall: number
  read: number
}

interface State {
  readonly current: TiaRuntimeGraph
  readonly currentChanged: TiaRuntimeGraph
  readonly old: LegacyRuntimeGraph
  readonly oldChanged: LegacyRuntimeGraph
  readonly oldStore: LegacyStore
  readonly runtime: ManagedRuntime.ManagedRuntime<GraphStore, never>
}

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
  const run = <A>(effect: Effect.Effect<A, unknown, GraphStore>) =>
    inputs.runtime.runPromise(effect)
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
  if (read.value.graph === null) throw new Error('the store read no graph')
  const stored = read.value
  settle()
  const small = await timedAsync(() =>
    run(
      Effect.flatMap(GraphStore, (store) =>
        store.commit(directory, {
          expected: stored.graph,
          expectedDigest: stored.digest,
          graph: inputs.currentChanged,
        }),
      ),
    ),
  )
  if (small.value.status !== 'committed') {
    throw new Error(`the small commit was ${small.value.status}`)
  }
  return { commitFull: full.ms, commitSmall: small.ms, read: read.ms }
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
  if (read.value.graph === null) throw new Error('1.x read no graph')
  const stored = read.value
  settle()
  const small = await timedAsync(() =>
    commitGraph(directory, {
      expected: stored.graph,
      expectedDigest: stored.digest,
      graph: inputs.oldChanged,
    }),
  )
  if (small.value.status !== 'committed') {
    throw new Error(`the small 1.x commit was ${small.value.status}`)
  }
  return { commitFull: full.ms, commitSmall: small.ms, read: read.ms }
}

/**
 * The graph store on a large runtime graph, in-process: a first commit of the
 * whole graph, a cold read of it back and a commit of one test's new result
 * and coverage on top of the read graph. 1.x's read includes its digest, which
 * its engine takes right after reading.
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
      ...versus(
        'commit-small',
        timings.current.commitSmall,
        timings.legacy.commitSmall,
      ),
    }
  },
  async setup() {
    const current = runtimeGraph(LARGE_GRAPH)
    const old = legacyLayout(current)
    state = {
      current,
      currentChanged: afterOneTestReran(current, LARGE_GRAPH),
      old,
      oldChanged: afterOneTestReran(old, LARGE_GRAPH),
      oldStore: await legacy<LegacyStore>('engine/state/store.js'),
      runtime: ManagedRuntime.make(
        GraphStoreLive.pipe(Layer.provide(NodeServices.layer)),
      ),
    }
  },
  summary: `GraphStore commit, read and small commit on a runtime graph of ${LARGE_GRAPH.tests} tests with per-test coverage, in-process, on disk`,
  async teardown() {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true })
    }
    await state?.runtime.dispose()
    state = undefined
  },
  warmup: 1,
}
