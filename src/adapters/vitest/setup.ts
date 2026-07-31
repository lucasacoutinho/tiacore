import { aroundEach, beforeAll, inject } from 'vitest'

import {
  coverageDelta,
  executedFilesSince,
  mergeCoverageMaps,
  snapshotCoverage,
} from '../../integrations/coverage/runtime.js'
import {
  TIA_META_KEY,
  TIA_REPLAY_META_KEY,
  TIA_SELECTION_KEY,
  TIA_TEST_META_KEY,
} from '../../shared/constants.js'
import type {
  CoverageMapLike,
  TiaCoverageMap,
  TiaModuleMeta,
  TiaTestSelection,
  TiaTestMeta,
} from '../../shared/types.js'

const coverage = (): CoverageMapLike | undefined =>
  (globalThis as typeof globalThis & { __coverage__?: CoverageMapLike }).__coverage__

const baseline = snapshotCoverage(coverage())
let boundary = baseline
const collectionFiles = new Set<string>()
let collectionCoverage: TiaCoverageMap = {}
let concurrent = false
const selection = (() => {
  try {
    return inject(TIA_SELECTION_KEY)
  } catch {
    return {
      mode: 'all',
      testIds: [],
      wholeTestFiles: [],
    } satisfies TiaTestSelection
  }
})()
const selectedIds = new Set(selection.testIds)
const wholeTestFiles = new Set(selection.wholeTestFiles)
const normalizePath = (path: string): string => path.replaceAll('\\', '/')

function recordCollectionGap(): void {
  const current = coverage()
  for (const file of executedFilesSince(boundary, current)) {
    collectionFiles.add(file)
  }
  collectionCoverage = mergeCoverageMaps(
    collectionCoverage,
    coverageDelta(boundary, current),
  )
  boundary = snapshotCoverage(current)
}

function moduleMeta(): TiaModuleMeta {
  return {
    collectionCoverage: concurrent
      ? coverageDelta(baseline, coverage())
      : collectionCoverage,
    collectionFiles: concurrent
      ? executedFilesSince(baseline, coverage())
      : [...collectionFiles].sort(),
    concurrent,
    files: executedFilesSince(baseline, coverage()),
  }
}

beforeAll(({}, suite) => {
  recordCollectionGap()

  return () => {
    if (!concurrent) {
      recordCollectionGap()
    }
    suite.meta[TIA_META_KEY] = moduleMeta()
  }
})

aroundEach(async (runTest, context) => {
  const testFile = normalizePath(context.task.file.filepath)
  concurrent ||= context.task.concurrent === true
  if (!concurrent) {
    recordCollectionGap()
  }
  if (
    selection.mode === 'tests' &&
    !wholeTestFiles.has(testFile) &&
    !selectedIds.has(context.task.id)
  ) {
    context.task.meta[TIA_REPLAY_META_KEY] = true
    context.skip('replayed from the tiacore cache')
  }

  const before = snapshotCoverage(coverage())

  try {
    await runTest()
  } finally {
    const meta: TiaTestMeta = {
      coverage: coverageDelta(before, coverage()),
      files: executedFilesSince(before, coverage()),
    }
    context.task.meta[TIA_TEST_META_KEY] = meta
    boundary = snapshotCoverage(coverage())
  }
})
