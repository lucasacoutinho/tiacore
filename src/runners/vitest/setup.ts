// Runs inside every Vitest worker (and browser-mode iframe) before each test
// file. Plain TypeScript: no Effect and no Node built-ins on this path.
//
// Attribution windows, in Vitest's per-test order:
//   aroundEach start -> beforeEach hooks (parents first) -> body -> afterEach
//   hooks -> aroundEach end.
// A marker appended to every suite's beforeEach list runs after that suite's
// own hooks; the marker of the test's own suite is the last one to run, so the
// body window opens there. A marker placed to run first among afterEach hooks
// closes it. Coverage outside the body (fixtures, lazily built layers, hooks)
// becomes the module's collection coverage, which every test of the module
// shares. When hooks run in parallel the body cannot be bounded, and the
// module is recorded in concurrent mode: its tests fall back to whole-file
// selection.
import type {} from './augmentations.ts'

import {
  aroundEach,
  beforeAll,
  inject,
  TestRunner,
  type RunnerTestFile,
  type RunnerTestSuite,
  type TestContext,
} from 'vitest'

import { installProbe } from '../../probe/ledger.ts'
import type { ProbeCoverageMap, ProbeTestWindow } from '../../probe/types.ts'
import {
  TIA_META_KEY,
  TIA_REPLAY_META_KEY,
  TIA_SELECTION_KEY,
  TIA_TEST_META_KEY,
  type TiaTestSelection,
} from './protocol.ts'

const probe = installProbe(
  () =>
    (globalThis as typeof globalThis & { __coverage__?: ProbeCoverageMap })
      .__coverage__,
)

function providedSelection(): TiaTestSelection {
  try {
    return inject(TIA_SELECTION_KEY)
  } catch {
    return { hooks: 'stack', mode: 'all', testIds: [], wholeTestFiles: [] }
  }
}

const selection = providedSelection()
const selectedIds = new Set(selection.testIds)
const wholeTestFiles = new Set(selection.wholeTestFiles)
const boundedHooks = selection.hooks !== 'parallel'
const windows = new Map<string, ProbeTestWindow>()

/** Whether this marker belongs to the suite that owns the test's body window. */
function ownsBody(
  context: TestContext,
  suite: RunnerTestSuite | RunnerTestFile,
): boolean {
  return (
    context.task.concurrent !== true &&
    (context.task.suite ?? context.task.file) === suite
  )
}

function installMarkers(suite: RunnerTestSuite | RunnerTestFile): void {
  const hooks = TestRunner.getSuiteHooks(suite)
  hooks.beforeEach.push((context: TestContext) => {
    probe.gap()
    if (ownsBody(context, suite)) probe.beginTest(context.task.id)
  })
  const closeBody = (context: TestContext) => {
    if (ownsBody(context, suite)) {
      windows.set(context.task.id, probe.endTest(context.task.id))
    }
  }
  // 'stack' runs afterEach hooks in reverse registration order.
  if (selection.hooks === 'stack') hooks.afterEach.push(closeBody)
  else hooks.afterEach.unshift(closeBody)
  for (const task of suite.tasks) {
    if (task.type === 'suite') installMarkers(task)
  }
}

beforeAll(({}, file) => {
  probe.gap()
  if (boundedHooks) installMarkers(file)
  return () => {
    probe.gap()
    file.meta[TIA_META_KEY] = probe.closeModule()
  }
})

aroundEach(async (runTest, context) => {
  probe.gap()
  const file = context.task.file.filepath.replaceAll('\\', '/')
  if (
    selection.mode === 'tests' &&
    !wholeTestFiles.has(file) &&
    !selectedIds.has(context.task.id)
  ) {
    context.task.meta[TIA_REPLAY_META_KEY] = true
    context.skip('replayed from the tiacore cache')
  }
  const concurrent = context.task.concurrent === true || !boundedHooks
  if (concurrent) probe.beginTest(context.task.id, true)
  try {
    await runTest()
  } finally {
    const window = concurrent
      ? probe.endTest(context.task.id)
      : windows.get(context.task.id)
    windows.delete(context.task.id)
    probe.gap()
    context.task.meta[TIA_TEST_META_KEY] = window ?? { coverage: {}, files: [] }
  }
})
