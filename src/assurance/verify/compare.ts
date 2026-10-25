import * as Match from 'effect/Match'

import { canonicalJson } from '../../core/canonical.ts'
import type { TiaCoverageRecord, TiaRuntimeGraph } from '../../core/runtime.ts'
import type {
  TiaVerificationIssue,
  TiaVerificationRunnerResult,
  TiaVerificationSnapshot,
} from '../../core/verification.ts'
import { verdict, type VerdictIssue } from '../../core/verdict.ts'
import { hashBytes } from '../../engine/baseline/fingerprint.ts'
import { auditVerificationSelection } from './selection.ts'

function digest(value: unknown): string {
  return hashBytes(canonicalJson(value))
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
  return Match.value(issue).pipe(
    Match.discriminatorsExhaustive('code')({
      'coverage-mismatch': () =>
        'selective and full phases produced different reconstructed coverage evidence',
      'dependency-mismatch': () =>
        'selective and full phases produced different dependency evidence',
      'incomplete-graph': ({ phase }) =>
        `${phase} phase produced an incomplete graph`,
      'outcome-mismatch': () =>
        'selective and full phases produced different test outcomes',
      'selection-miss': ({ missed }) => {
        const remainder = missed.length - 3
        return `selective phase missed ${missed.length} required test${
          missed.length === 1 ? '' : 's'
        }: ${missed.slice(0, 3).join(', ')}${
          remainder > 0 ? ` and ${remainder} more` : ''
        }`
      },
    }),
  )
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
