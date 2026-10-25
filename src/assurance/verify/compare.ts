import type { TiaCoverageRecord, TiaRuntimeGraph } from '../../core/runtime.ts'
import type {
  TiaVerificationRunnerResult,
  TiaVerificationSnapshot,
} from '../../core/verification.ts'
import { verdict } from '../../core/verdict.ts'
import { digest, verdictIssues } from './issues.ts'
import { auditVerificationSelection } from './selection.ts'

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
  const issues = verdictIssues(runner, result)
  return { issues, runner, selection, verified: result.verified }
}
