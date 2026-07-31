import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  TIA_ADAPTER_CONFORMANCE_SCENARIOS,
  certifyAdapterReceipt,
  parseAdapterCertificationReceipt,
  type TiaAdapterCertificationReceipt,
} from '../../../src/entries/conformance.js'

function receipt(): TiaAdapterCertificationReceipt {
  return {
    adapter: 'example-node',
    capabilityLevel: 'runtime-tia',
    contractVersion: 1,
    environment: {
      architecture: 'x64',
      operatingSystem: 'linux',
    },
    features: [],
    generatedAt: '2026-07-30T00:00:00.000Z',
    protocolVersion: 1,
    runner: {
      name: 'example',
      version: '1.0.0',
    },
    scenarios: TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
      (scenario) =>
        scenario.feature === undefined &&
        (
          scenario.capabilityLevels === undefined ||
          scenario.capabilityLevels.includes('runtime-tia')
        ),
    ).map(({ id }) => ({
      evidence: {
        assertions: 1,
        fixture: `fixtures/${id}`,
      },
      id,
      passed: true,
    })),
    selectionGranularity: 'test-case',
    sourceRevision: '0123456789abcdef',
  }
}

describe('adapter conformance certification', () => {
  test('keeps the public scenario catalog synchronized with JSON', () => {
    const catalog = JSON.parse(
      readFileSync(
        join(process.cwd(), 'conformance/adapter/v1/scenarios.json'),
        'utf8',
      ),
    ) as {
      contractVersion: number
      scenarios: unknown[]
    }
    expect(catalog.contractVersion).toBe(1)
    expect(catalog.scenarios).toEqual(TIA_ADAPTER_CONFORMANCE_SCENARIOS)
  })

  test('certifies a complete capability-scoped receipt', () => {
    expect(certifyAdapterReceipt(receipt())).toMatchObject({
      adapter: 'example-node',
      capabilityLevel: 'runtime-tia',
      passedScenarios: 12,
      runner: 'example@1.0.0',
      sourceRevision: '0123456789abcdef',
    })
  })

  test('requires feature-specific scenarios only when declared', () => {
    const value = receipt()
    value.features = ['parallelism']
    expect(() => certifyAdapterReceipt(value)).toThrow(
      /parallel-plan-deterministic/,
    )
    value.scenarios.push({
      evidence: { assertions: 2, fixture: 'fixtures/parallel' },
      id: 'parallel-plan-deterministic',
      passed: true,
    })
    expect(certifyAdapterReceipt(value).features).toEqual(['parallelism'])
  })

  test('rejects missing, failed, duplicate, and assertion-free evidence', () => {
    const missing = receipt()
    missing.scenarios.pop()
    expect(() => certifyAdapterReceipt(missing)).toThrow(/missing scenarios/)

    const failed = receipt()
    failed.scenarios[0]!.passed = false
    expect(() => certifyAdapterReceipt(failed)).toThrow(/failed scenarios/)

    const duplicate = receipt()
    duplicate.scenarios.push(structuredClone(duplicate.scenarios[0]!))
    expect(() => parseAdapterCertificationReceipt(duplicate)).toThrow(
      /duplicate values/,
    )

    const assertionFree = receipt()
    assertionFree.scenarios[0]!.evidence.assertions = 0
    expect(() => certifyAdapterReceipt(assertionFree)).toThrow(
      /has no assertions/,
    )
  })
})
