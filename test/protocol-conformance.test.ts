import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { createImpactPlan } from '../src/core/impact.js'
import type {
  TiaExecutionPolicy,
  TiaImpactGraph,
  TiaImpactPlan,
  TiaSuiteDescriptor,
} from '../src/protocol/types.js'
import {
  parseArtifactEnvelope,
  parseImpactGraph,
} from '../src/protocol/validate.js'

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), 'conformance/protocol/v1', name),
      'utf8',
    ),
  ) as T
}

interface PlanVector {
  changes: string[]
  environmentFingerprint: string
  expected: TiaImpactPlan
  fingerprint: string
  name: string
  policy?: TiaExecutionPolicy
}

interface PlanVectors {
  catalog: TiaSuiteDescriptor[]
  graph: TiaImpactGraph
  protocolVersion: number
  vectors: PlanVector[]
}

interface InvalidGraphVectors {
  protocolVersion: number
  vectors: Array<{
    errorIncludes: string
    graph: unknown
    name: string
  }>
}

describe('protocol v1 conformance vectors', () => {
  const plans = fixture<PlanVectors>('plans.json')
  const invalid = fixture<InvalidGraphVectors>('invalid-graphs.json')
  const canonical = fixture<{
    expected: TiaImpactGraph
    input: unknown
    protocolVersion: number
  }>('canonicalization.json')

  test('ships vectors for the current protocol version', () => {
    expect(plans.protocolVersion).toBe(1)
    expect(invalid.protocolVersion).toBe(1)
    expect(canonical.protocolVersion).toBe(1)
  })

  test.each(plans.vectors)('$name', (vector) => {
    expect(
      createImpactPlan({
        catalog: plans.catalog,
        changes: { files: vector.changes, provider: 'conformance' },
        currentEnvironmentFingerprint: vector.environmentFingerprint,
        currentFingerprint: vector.fingerprint,
        graph: plans.graph,
        ...(vector.policy === undefined ? {} : { policy: vector.policy }),
      }),
    ).toEqual(vector.expected)
  })

  test.each(invalid.vectors)('$name', (vector) => {
    expect(() => parseImpactGraph(vector.graph)).toThrow(vector.errorIncludes)
  })

  test('returns the canonical graph form', () => {
    expect(parseImpactGraph(canonical.input)).toEqual(canonical.expected)
  })

  test('validates portable artifact partitions', () => {
    expect(
      parseArtifactEnvelope({
        adapter: 'example',
        artifactId: 'artifact-1',
        graph: plans.graph,
        partition: { group: 'run-1', index: 1, total: 2 },
        runId: 'run-1',
      }),
    ).toMatchObject({
      adapter: 'example',
      artifactId: 'artifact-1',
      partition: { group: 'run-1', index: 1, total: 2 },
      runId: 'run-1',
    })
    expect(() =>
      parseArtifactEnvelope({
        adapter: 'example',
        artifactId: 'artifact-1',
        graph: plans.graph,
        partition: { index: 3, total: 2 },
        runId: 'run-1',
      }),
    ).toThrow(/one-based partition/)
  })
})
