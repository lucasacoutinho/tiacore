import { describe, expect, test } from 'vitest'

import {
  TIA_ADAPTER_CONFORMANCE_SCENARIOS,
  certifyAdapterReceipt,
  executeAdapterCertification,
} from '../../../src/entries/conformance.js'

describe('executable adapter certification', () => {
  test('ties every claimed scenario to a bounded real process execution', async () => {
    const receipt = await executeAdapterCertification({
      adapter: 'fixture-static',
      capabilityLevel: 'static-impact',
      root: process.cwd(),
      runner: { name: 'node', version: process.versions.node },
      scenarios: TIA_ADAPTER_CONFORMANCE_SCENARIOS
        .filter((scenario) => scenario.capabilityLevels === undefined && scenario.feature === undefined)
        .map(({ id }) => ({
          arguments: ['-e', 'process.exit(0)'],
          command: process.execPath,
          fixture: `test/fixtures/${id}`,
          id,
        })),
      selectionGranularity: 'test-file',
      sourceRevision: 'sha256:fixture',
    })
    expect(certifyAdapterReceipt(receipt)).toMatchObject({
      adapter: 'fixture-static',
      passedScenarios: 9,
    })
    expect(receipt.scenarios.every((scenario) =>
      (scenario.evidence.durationMs ?? 0) >= 0 && Boolean(scenario.evidence.command),
    )).toBe(true)
  })
})
