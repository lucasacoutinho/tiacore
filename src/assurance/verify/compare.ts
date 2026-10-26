import { byCodeUnit, canonicalJson } from '../../core/canonical.ts'
import type { TiaCoverageRecord, TiaRuntimeGraph } from '../../core/runtime.ts'
import type {
  TiaCoverageDifference,
  TiaVerificationRunnerResult,
  TiaVerificationSnapshot,
} from '../../core/verification.ts'
import { verdict } from '../../core/verdict.ts'
import { digest, verdictIssues } from './issues.ts'
import { auditVerificationSelection } from './selection.ts'

const COVERAGE_DIFFERENCE_LIMIT = 8

const COUNTER_KINDS = [
  ['branch', 'b'],
  ['function', 'f'],
  ['statement', 's'],
] as const

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

function coverageDigest(
  evidence: Record<string, TiaCoverageRecord>,
  complete: boolean,
): string {
  return digest({ collectionCoverage: evidence, complete })
}

function sameCounters(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function coverageDifferences(
  selective: Record<string, TiaCoverageRecord>,
  full: Record<string, TiaCoverageRecord>,
): TiaCoverageDifference[] {
  const testFiles = [
    ...new Set([...Object.keys(selective), ...Object.keys(full)]),
  ].sort(byCodeUnit)
  const differences: TiaCoverageDifference[] = []
  for (const testFile of testFiles) {
    const leftFiles = selective[testFile] ?? {}
    const rightFiles = full[testFile] ?? {}
    const sourceFiles = [
      ...new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)]),
    ].sort(byCodeUnit)
    for (const sourceFile of sourceFiles) {
      const left = leftFiles[sourceFile]
      const right = rightFiles[sourceFile]
      for (const [kind, key] of COUNTER_KINDS) {
        if (sameCounters(left?.[key] ?? {}, right?.[key] ?? {})) continue
        differences.push({ kind, sourceFile, testFile })
        if (differences.length === COVERAGE_DIFFERENCE_LIMIT) return differences
      }
    }
  }
  return differences
}

function coverageReport(
  selective: TiaRuntimeGraph,
  full: TiaRuntimeGraph,
): {
  checked: boolean
  differences: TiaCoverageDifference[]
  equal: boolean
} {
  if (!selective.coverageComplete && !full.coverageComplete) {
    return { checked: false, differences: [], equal: true }
  }
  const selectiveEvidence = coverageEvidence(selective)
  const fullEvidence = coverageEvidence(full)
  const equal =
    coverageDigest(selectiveEvidence, selective.coverageComplete) ===
    coverageDigest(fullEvidence, full.coverageComplete)
  return {
    checked: true,
    differences: equal
      ? []
      : coverageDifferences(selectiveEvidence, fullEvidence),
    equal,
  }
}

export function compareVerificationSnapshots(
  selective: TiaVerificationSnapshot,
  full: TiaVerificationSnapshot,
): TiaVerificationRunnerResult {
  const runner = full.runner
  const selection = auditVerificationSelection(selective, full)
  const coverage = coverageReport(selective.graph, full.graph)
  const result = verdict({
    coverageChecked: coverage.checked,
    coverageEqual: coverage.equal,
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
  const issues = verdictIssues(runner, result).map((issue) =>
    issue.code === 'coverage-mismatch'
      ? { ...issue, differences: coverage.differences }
      : issue,
  )
  return { issues, runner, selection, verified: result.verified }
}
