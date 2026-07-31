import { createHash } from 'node:crypto'

import type {
  CachedTestResult,
  TiaRuntimeGraph,
  TiaTestEdge,
} from '../engine/types.js'
import type {
  TiaVerificationIssue,
  TiaVerificationRunnerResult,
  TiaVerificationSnapshot,
} from './types.js'
import { auditVerificationSelection } from './selection.js'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

function outcomes(
  graph: TiaRuntimeGraph,
): Record<string, Omit<CachedTestResult, 'duration'>> {
  return Object.fromEntries(
    Object.entries(graph.results).map(([id, result]) => [
      id,
      {
        file: result.file,
        fullName: result.fullName,
        id: result.id,
        state: result.state,
      },
    ]),
  )
}

function dependencies(graph: TiaRuntimeGraph): {
  edges: Record<string, string[]>
  testEdges: Record<string, TiaTestEdge>
} {
  return {
    edges: graph.edges,
    testEdges: graph.testEdges,
  }
}

function hit(value: number): 0 | 1 {
  return value === 0 ? 0 : 1
}

function coverageEvidence(
  graph: TiaRuntimeGraph,
): TiaRuntimeGraph['collectionCoverage'] {
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
            f: Object.fromEntries(
              Object.entries(value.f).map(([id, count]) => [id, hit(count)]),
            ),
            s: Object.fromEntries(
              Object.entries(value.s).map(([id, count]) => [id, hit(count)]),
            ),
          },
        ]),
      ),
    ]),
  )
}

function issue(
  runner: string,
  code: TiaVerificationIssue['code'],
  message: string,
): TiaVerificationIssue {
  return { code, message, runner }
}

export function compareVerificationSnapshots(
  selective: TiaVerificationSnapshot,
  full: TiaVerificationSnapshot,
): TiaVerificationRunnerResult {
  const runner = full.runner
  const issues: TiaVerificationIssue[] = []
  const selection = auditVerificationSelection(selective, full)

  if (selection.missedTestIds.length > 0) {
    const examples = selection.missedTestIds.slice(0, 3).join(', ')
    const remainder = selection.missedTestIds.length - 3
    issues.push(
      issue(
        runner,
        'selection-miss',
        `selective phase missed ${selection.missedTestIds.length} required test${
          selection.missedTestIds.length === 1 ? '' : 's'
        }: ${examples}${remainder > 0 ? ` and ${remainder} more` : ''}`,
      ),
    )
  }

  if (!selective.graph.complete) {
    issues.push(
      issue(
        runner,
        'incomplete-graph',
        'selective phase produced an incomplete graph',
      ),
    )
  }
  if (!full.graph.complete) {
    issues.push(
      issue(
        runner,
        'incomplete-graph',
        'full phase produced an incomplete graph',
      ),
    )
  }

  const selectiveOutcomes = outcomes(selective.graph)
  const fullOutcomes = outcomes(full.graph)
  if (digest(selectiveOutcomes) !== digest(fullOutcomes)) {
    issues.push(
      issue(
        runner,
        'outcome-mismatch',
        'selective and full phases produced different test outcomes',
      ),
    )
  }

  const selectiveDependencies = dependencies(selective.graph)
  const fullDependencies = dependencies(full.graph)
  if (digest(selectiveDependencies) !== digest(fullDependencies)) {
    issues.push(
      issue(
        runner,
        'dependency-mismatch',
        'selective and full phases produced different dependency evidence',
      ),
    )
  }

  if (selective.graph.coverageComplete || full.graph.coverageComplete) {
    const selectiveCoverage = {
      collectionCoverage: coverageEvidence(selective.graph),
      complete: selective.graph.coverageComplete,
    }
    const fullCoverage = {
      collectionCoverage: coverageEvidence(full.graph),
      complete: full.graph.coverageComplete,
    }
    if (digest(selectiveCoverage) !== digest(fullCoverage)) {
      issues.push(
        issue(
          runner,
          'coverage-mismatch',
          'selective and full phases produced different reconstructed coverage evidence',
        ),
      )
    }
  }

  return {
    issues,
    runner,
    selection,
    verified: issues.length === 0,
  }
}
