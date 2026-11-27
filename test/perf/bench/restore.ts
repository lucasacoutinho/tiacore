import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import type { RunPlan } from '../../../src/core/runtime.ts'
import { artifactRestore } from '../../../src/engine/artifacts/restore-step.ts'
import { BaselinesLive } from '../../../src/engine/baseline/live.ts'
import { beginRun, type RestoreStep } from '../../../src/engine/lifecycle.ts'
import { Baselines, GraphStore } from '../../../src/engine/ports.ts'
import { GraphStoreLive } from '../../../src/engine/state/graph-store.ts'
import { versus } from '../../support/bench-report.ts'
import {
  LARGE_GRAPH,
  legacyLayout,
  runtimeGraph,
  testFileName,
  type LegacyRuntimeGraph,
} from '../../support/bench-graph.ts'
import { bothVersionsAsync, timedAsync } from '../../support/bench-run.ts'
import { legacy } from '../../support/legacy.ts'
import type { Workload } from './workload.ts'

// The prepare of a project whose configuration names an artifact source while
// a usable graph is already stored locally, in-process on a large graph: the
// restore checks the local graph and keeps it, and the plan reads it.

const FINGERPRINT = 'bench-fingerprint'
const CACHE = '.tia'
const SOURCES = [{ paths: ['.tia-artifacts'], provider: 'filesystem' as const }]
const PLAN_OPTIONS = {
  fresh: false,
  ignoreChanges: [],
  onUnknownChange: 'full' as const,
}

interface LegacyBegun {
  readonly graph: unknown
  readonly plan: RunPlan
}

interface Legacy {
  readonly artifactProviders: (sources: unknown) => unknown[]
  readonly beginRuntimeRun: (input: {
    cacheDir: string
    fingerprint: string
    ignoredPrefixes: string[]
    options: Record<string, unknown>
    root: string
  }) => Promise<LegacyBegun>
  readonly commitGraph: (
    cacheDir: string,
    options: {
      expected: null
      expectedDigest: null
      graph: LegacyRuntimeGraph
    },
  ) => Promise<{ status: string }>
}

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(GraphStoreLive, BaselinesLive).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  )

interface State {
  readonly legacy: Legacy
  /** A project per version, each holding its version's stored graph. */
  readonly roots: { readonly current: string; readonly legacy: string }
  readonly restore: RestoreStep<Baselines | GraphStore>
  readonly runtime: ReturnType<typeof makeRuntime>
}

let state: State | undefined

/** A project directory with every test file of the graph, all empty. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'tiacore-bench-restore-'))
  for (let index = 0; index < LARGE_GRAPH.testFiles; index += 1) {
    const path = join(root, testFileName(index))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
  }
  return root
}

/** Fails the benchmark unless the plan kept the stored local graph. */
function expectLocal(version: string, plan: RunPlan): void {
  if (plan.baseline.origin !== 'local') {
    throw new Error(
      `the ${version} prepare planned from ${JSON.stringify(plan.baseline)}`,
    )
  }
}

async function currentPrepare(inputs: State, restore: boolean) {
  const root = inputs.roots.current
  const timed = await timedAsync(() =>
    inputs.runtime.runPromise(
      beginRun({
        cacheDir: join(root, CACHE),
        ignoredPrefixes: [CACHE],
        options: PLAN_OPTIONS,
        ...(restore ? { restore: inputs.restore } : {}),
        root,
        snapshot: { baseline: null, fingerprint: FINGERPRINT },
      }),
    ),
  )
  expectLocal('2.0', timed.value.plan)
  return timed.ms
}

async function legacyPrepare(inputs: State, restore: boolean) {
  const root = inputs.roots.legacy
  const timed = await timedAsync(() =>
    inputs.legacy.beginRuntimeRun({
      cacheDir: join(root, CACHE),
      fingerprint: FINGERPRINT,
      ignoredPrefixes: [CACHE],
      options: {
        ...PLAN_OPTIONS,
        artifactProviders: restore
          ? inputs.legacy.artifactProviders(SOURCES)
          : [],
        artifactTrust: {},
        log: false,
      },
      root,
    }),
  )
  expectLocal('1.x', timed.value.plan)
  return timed.ms
}

/**
 * TiaCore's prepare, in-process, with a usable graph of ${LARGE_GRAPH.tests}
 * tests stored locally: once with a filesystem artifact source configured and
 * once without. The project is not a repository, so both plan a full run.
 */
export const restore: Workload = {
  name: 'restore',
  async round(index) {
    if (state === undefined) throw new Error('restore ran before its setup')
    const inputs = state
    const result = {}
    for (const configured of [true, false]) {
      // A collection pending from the previous prepare would land in this one.
      const timings = await bothVersionsAsync(index, (version) => {
        globalThis.gc?.()
        return version === 'current'
          ? currentPrepare(inputs, configured)
          : legacyPrepare(inputs, configured)
      })
      Object.assign(
        result,
        versus(
          configured ? 'prepare-artifacts' : 'prepare',
          timings.current,
          timings.legacy,
        ),
      )
    }
    return result
  },
  async setup() {
    const graph = runtimeGraph(LARGE_GRAPH)
    const stamped = { ...graph, fingerprint: FINGERPRINT }
    const runtime = makeRuntime()
    const roots = { current: project(), legacy: project() }
    const [store, engine, run] = await Promise.all([
      legacy<Pick<Legacy, 'commitGraph'>>('engine/state/store.js'),
      legacy<Pick<Legacy, 'artifactProviders'>>('engine/artifacts/restore.js'),
      legacy<Pick<Legacy, 'beginRuntimeRun'>>('engine/lifecycle.js'),
    ])
    await runtime.runPromise(
      Effect.flatMap(GraphStore, (graphs) =>
        graphs.commit(join(roots.current, CACHE), {
          expected: null,
          expectedDigest: null,
          graph: stamped,
        }),
      ),
    )
    await store.commitGraph(join(roots.legacy, CACHE), {
      expected: null,
      expectedDigest: null,
      graph: legacyLayout(stamped),
    })
    const step = await runtime.runPromise(artifactRestore(SOURCES, false, {}))
    if (step === undefined) throw new Error('no restore step for the sources')
    state = {
      legacy: { ...store, ...engine, ...run },
      roots,
      restore: step,
      runtime,
    }
  },
  summary: `TiaCore prepare with a usable local graph of ${LARGE_GRAPH.tests} tests, with and without a filesystem artifact source configured, in-process`,
  async teardown() {
    if (state !== undefined) {
      rmSync(state.roots.current, { force: true, recursive: true })
      rmSync(state.roots.legacy, { force: true, recursive: true })
      await state.runtime.dispose()
    }
    state = undefined
  },
  warmup: 1,
}
