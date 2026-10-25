import { createHash } from 'node:crypto'

import { byCodeUnit } from '../../core/canonical.ts'
import type { TiaCoverageRecord, TiaRuntimeGraph } from '../../core/runtime.ts'
import type {
  TiaVerificationIssue,
  TiaVerificationRunnerResult,
  TiaVerificationSnapshot,
} from '../../core/verification.ts'
import { verdict, type VerdictIssue } from '../../core/verdict.ts'
import { auditVerificationSelection } from './selection.ts'

/** Plain data with object keys sorted at every depth and array order kept. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => byCodeUnit(left, right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

function outcomes(graph: TiaRuntimeGraph) {
  return Object.fromEntries(
    Object.values(graph.results).map((result) => [
      result.id,
      {
        file: result.file,
        fullName: result.fullName,
        id: result.id,
        state: result.state,
      },
    ]),
  )
}

function dependencies(graph: TiaRuntimeGraph) {
  return { edges: graph.edges, testEdges: graph.testEdges }
}

function hit(value: number): 0 | 1 {
  return value === 0 ? 0 : 1
}

function hitMap(counters: Record<string, number>): Record<string, 0 | 1> {
  return Object.fromEntries(
    Object.entries(counters).map(([id, count]) => [id, hit(count)]),
  )
}

/** Coverage topology: which counters advanced, not by how much. */
function coverageEvidence(
  graph: TiaRuntimeGraph,
): Record<string, TiaCoverageRecord> {
  return Object.fromEntries(
    Object.entries(graph.collectionCoverage).map(([testFile, coverage]) => [
      testFile,
      Object.fromEntries(
        Object.entries(coverage).map(([file, value]) => [
          file,
          {
            ...value,
            b: Object.fromEntries(
              Object.entries(value.b).map(([id, counts]) => [
                id,
                counts.map(hit),
              ]),
            ),
            f: hitMap(value.f),
            s: hitMap(value.s),
          },
        ]),
      ),
    ]),
  )
}

function coverageDigest(graph: TiaRuntimeGraph): string {
  return digest({
    collectionCoverage: coverageEvidence(graph),
    complete: graph.coverageComplete,
  })
}

function describe(issue: VerdictIssue): string {
  switch (issue.code) {
    case 'selection-miss': {
      const count = issue.missed.length
      const remainder = count - 3
      return `selective phase missed ${count} required test${
        count === 1 ? '' : 's'
      }: ${issue.missed.slice(0, 3).join(', ')}${
        remainder > 0 ? ` and ${remainder} more` : ''
      }`
    }
    case 'incomplete-graph':
      return `${issue.phase} phase produced an incomplete graph`
    case 'outcome-mismatch':
      return 'selective and full phases produced different test outcomes'
    case 'dependency-mismatch':
      return 'selective and full phases produced different dependency evidence'
    case 'coverage-mismatch':
      return 'selective and full phases produced different reconstructed coverage evidence'
  }
}

export function compareVerificationSnapshots(
  selective: TiaVerificationSnapshot,
  full: TiaVerificationSnapshot,
): TiaVerificationRunnerResult {
  const runner = full.runner
  const selection = auditVerificationSelection(selective, full)
  const coverageChecked =
    selective.graph.coverageComplete || full.graph.coverageComplete
  const result = verdict({
    coverageChecked,
    coverageEqual:
      !coverageChecked ||
      coverageDigest(selective.graph) === coverageDigest(full.graph),
    dependenciesEqual:
      digest(dependencies(selective.graph)) ===
      digest(dependencies(full.graph)),
    executed: selection.executedTestIds,
    expected: selection.expectedTestIds,
    fullComplete: full.graph.complete,
    outcomesEqual:
      digest(outcomes(selective.graph)) === digest(outcomes(full.graph)),
    selectiveComplete: selective.graph.complete,
  })
  const issues: TiaVerificationIssue[] = result.issues.map((issue) => ({
    code: issue.code,
    message: describe(issue),
    runner,
  }))
  return { issues, runner, selection, verified: result.verified }
}
