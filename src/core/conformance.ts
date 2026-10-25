import { byCodeUnit } from './canonical.ts'
import { TIA_PROTOCOL_VERSION } from './protocol.ts'

export const TIA_ADAPTER_CONFORMANCE_VERSION = 1 as const

export type TiaAdapterCapabilityLevel =
  | 'observed-file-tia'
  | 'runtime-tia'
  | 'static-impact'

export type TiaAdapterFeature =
  | 'cached-outcomes'
  | 'coverage-reconstruction'
  | 'parallelism'
  | 'partitions'
  | 'subprocess-observation'
  | 'worktrees'

export type TiaAdapterSelectionGranularity =
  | 'flow'
  | 'package'
  | 'profile'
  | 'test-case'
  | 'test-file'

export interface TiaAdapterScenarioEvidence {
  assertions: number
  command?: string
  durationMs?: number
  fixture: string
}

export interface TiaAdapterScenarioResult {
  evidence: TiaAdapterScenarioEvidence
  id: string
  passed: boolean
}

export interface TiaAdapterCertificationReceipt {
  adapter: string
  capabilityLevel: TiaAdapterCapabilityLevel
  contractVersion: typeof TIA_ADAPTER_CONFORMANCE_VERSION
  environment: {
    architecture: string
    operatingSystem: string
  }
  features: TiaAdapterFeature[]
  generatedAt: string
  protocolVersion: typeof TIA_PROTOCOL_VERSION
  runner: {
    name: string
    version: string
  }
  scenarios: TiaAdapterScenarioResult[]
  selectionGranularity: TiaAdapterSelectionGranularity
  sourceRevision: string
}

export interface TiaAdapterCertification {
  adapter: string
  capabilityLevel: TiaAdapterCapabilityLevel
  features: TiaAdapterFeature[]
  passedScenarios: number
  requiredScenarios: string[]
  runner: string
  sourceRevision: string
}

export interface TiaAdapterScenarioDefinition {
  capabilityLevels?: TiaAdapterCapabilityLevel[]
  feature?: TiaAdapterFeature
  id: string
}

export const TIA_ADAPTER_CONFORMANCE_SCENARIOS: readonly TiaAdapterScenarioDefinition[] =
  Object.freeze([
    { id: 'baseline-full' },
    { id: 'no-change-skip' },
    { id: 'affected-selective' },
    { id: 'unknown-change-full' },
    { id: 'structural-change-full' },
    { id: 'corrupt-graph-full' },
    { id: 'environment-change-full' },
    { id: 'cross-platform-paths' },
    { id: 'resource-locks' },
    {
      capabilityLevels: ['observed-file-tia', 'runtime-tia'],
      id: 'incomplete-observation-full',
    },
    {
      capabilityLevels: ['observed-file-tia', 'runtime-tia'],
      id: 'worker-crash-full',
    },
    {
      capabilityLevels: ['runtime-tia'],
      id: 'previous-failure-rerun',
    },
    { feature: 'cached-outcomes', id: 'cached-outcomes-replayed' },
    { feature: 'coverage-reconstruction', id: 'coverage-reconstructed' },
    { feature: 'parallelism', id: 'parallel-plan-deterministic' },
    { feature: 'partitions', id: 'partitions-complete-before-promotion' },
    { feature: 'subprocess-observation', id: 'subprocess-boundary-safe' },
    { feature: 'worktrees', id: 'worktree-ancestry-safe' },
  ] satisfies TiaAdapterScenarioDefinition[])

/** The scenario ids a receipt must pass, in code-unit order. */
export function requiredScenarioIds(
  capabilityLevel: TiaAdapterCapabilityLevel,
  features: readonly TiaAdapterFeature[],
): string[] {
  const enabled = new Set(features)
  return TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
    (scenario) =>
      (scenario.capabilityLevels === undefined ||
        scenario.capabilityLevels.includes(capabilityLevel)) &&
      (scenario.feature === undefined || enabled.has(scenario.feature)),
  )
    .map(({ id }) => id)
    .sort(byCodeUnit)
}

/**
 * Judges a parsed receipt. Missing scenarios are reported before failed ones,
 * failed before assertion-free ones.
 */
export function judgeReceipt(
  receipt: TiaAdapterCertificationReceipt,
):
  | { readonly certification: TiaAdapterCertification }
  | { readonly failure: string } {
  const required = requiredScenarioIds(
    receipt.capabilityLevel,
    receipt.features,
  )
  const results = new Map(
    receipt.scenarios.map((scenario) => [scenario.id, scenario]),
  )
  const missing = required.filter((id) => !results.has(id))
  if (missing.length > 0) {
    return {
      failure: `TIA adapter certification is missing scenarios: ${missing.join(', ')}`,
    }
  }
  const failed = required.filter((id) => results.get(id)?.passed !== true)
  if (failed.length > 0) {
    return {
      failure: `TIA adapter certification failed scenarios: ${failed.join(', ')}`,
    }
  }
  for (const id of required) {
    if ((results.get(id)?.evidence.assertions ?? 0) < 1) {
      return {
        failure: `TIA adapter certification scenario ${id} has no assertions`,
      }
    }
  }
  return {
    certification: {
      adapter: receipt.adapter,
      capabilityLevel: receipt.capabilityLevel,
      features: receipt.features,
      passedScenarios: required.length,
      requiredScenarios: required,
      runner: `${receipt.runner.name}@${receipt.runner.version}`,
      sourceRevision: receipt.sourceRevision,
    },
  }
}
