import * as Effect from 'effect/Effect'
import { expect, test } from 'vitest'

import type { CachedTestResult, TiaTestEdge } from '../../src/core/runtime.ts'
import { updateGraph } from '../../src/engine/state/update.ts'
import { EngineLive } from '../engine/support/layers.ts'
import { median } from '../support/stats.ts'

function recordCases(fileCount: number) {
  const files = Array.from({ length: fileCount }, (_, i) => `test/${i}.test.ts`)
  const results = new Map<string, CachedTestResult>()
  const testEdges = new Map<string, TiaTestEdge>()
  for (let i = 0; i < 4096; i += 1) {
    const id = `case-${i}`
    const file = files[i % files.length]!
    results.set(id, { id, file, fullName: id, state: 'passed' })
    testEdges.set(id, { file, files: [file, 'src/shared.ts'] })
  }
  return updateGraph({
    root: '.',
    previous: null,
    header: {
      baseline: { sha: 'head', workingTree: {} },
      complete: true,
      coverageComplete: false,
      fingerprint: 'perf',
      partition: null,
      updatedAt: new Date(0).toISOString(),
    },
    results,
    testEdges,
    executedFiles: files,
    fullyExecutedFiles: files,
    presentFiles: files,
  }).pipe(Effect.provide(EngineLive))
}

test('recording the same cases across more files avoids a scan per file', async () => {
  const compact = recordCases(16)
  const spread = recordCases(512)
  const measure = async (run: typeof compact) => {
    const start = performance.now()
    const graph = await Effect.runPromise(run)
    const elapsed = performance.now() - start
    expect(Object.keys(graph.results)).toHaveLength(4096)
    return elapsed
  }
  await measure(compact)
  await measure(spread)
  const ratios: number[] = []
  for (let round = 0; round < 7; round += 1) {
    if (round % 2 === 0) {
      const compactMs = await measure(compact)
      ratios.push((await measure(spread)) / compactMs)
    } else {
      const spreadMs = await measure(spread)
      ratios.push(spreadMs / (await measure(compact)))
    }
  }
  // Allow for the extra file-level records and machine noise. Rescanning
  // all 4,096 edges for each of 32 times as many files exceeds this budget.
  expect(
    median(ratios),
    `spread/compact ratios: ${ratios.join(', ')}`,
  ).toBeLessThan(4)
})
