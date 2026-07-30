import { TIA_PROTOCOL_VERSION } from '../protocol/types.js'

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
  selectionGranularity: 'flow' | 'profile' | 'test-case' | 'test-file'
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
  {
    feature: 'coverage-reconstruction',
    id: 'coverage-reconstructed',
  },
  { feature: 'parallelism', id: 'parallel-plan-deterministic' },
  {
    feature: 'partitions',
    id: 'partitions-complete-before-promotion',
  },
  {
    feature: 'subprocess-observation',
    id: 'subprocess-boundary-safe',
  },
  { feature: 'worktrees', id: 'worktree-ancestry-safe' },
  ] satisfies TiaAdapterScenarioDefinition[])

const CAPABILITY_LEVELS = new Set<TiaAdapterCapabilityLevel>([
  'observed-file-tia',
  'runtime-tia',
  'static-impact',
])
const FEATURES = new Set<TiaAdapterFeature>([
  'cached-outcomes',
  'coverage-reconstruction',
  'parallelism',
  'partitions',
  'subprocess-observation',
  'worktrees',
])
const GRANULARITIES = new Set([
  'flow',
  'profile',
  'test-case',
  'test-file',
])
const RECEIPT_KEYS = new Set([
  'adapter',
  'capabilityLevel',
  'contractVersion',
  'environment',
  'features',
  'generatedAt',
  'protocolVersion',
  'runner',
  'scenarios',
  'selectionGranularity',
  'sourceRevision',
])
const ENVIRONMENT_KEYS = new Set(['architecture', 'operatingSystem'])
const RUNNER_KEYS = new Set(['name', 'version'])
const SCENARIO_KEYS = new Set(['evidence', 'id', 'passed'])
const EVIDENCE_KEYS = new Set([
  'assertions',
  'command',
  'durationMs',
  'fixture',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function knownKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key))
  if (unknown !== undefined) {
    throw new Error(`${label} has an unknown field: ${unknown}`)
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  if (value.length > 8_192) throw new Error(`${label} is too long`)
  return value
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`${label} must be a non-negative number`)
  }
  return value
}

function requiredScenarioIds(
  capabilityLevel: TiaAdapterCapabilityLevel,
  features: readonly TiaAdapterFeature[],
): string[] {
  const enabled = new Set(features)
  return TIA_ADAPTER_CONFORMANCE_SCENARIOS.filter(
    (scenario) =>
      (
        scenario.capabilityLevels === undefined ||
        scenario.capabilityLevels.includes(capabilityLevel)
      ) &&
      (scenario.feature === undefined || enabled.has(scenario.feature)),
  )
    .map(({ id }) => id)
    .sort()
}

export function parseAdapterCertificationReceipt(
  value: unknown,
): TiaAdapterCertificationReceipt {
  const parsed = record(value, 'TIA adapter certification receipt')
  knownKeys(parsed, RECEIPT_KEYS, 'TIA adapter certification receipt')

  const capabilityLevel = text(
    parsed.capabilityLevel,
    'TIA adapter capability level',
  ) as TiaAdapterCapabilityLevel
  if (!CAPABILITY_LEVELS.has(capabilityLevel)) {
    throw new Error(`unsupported TIA adapter capability level: ${capabilityLevel}`)
  }
  if (parsed.contractVersion !== TIA_ADAPTER_CONFORMANCE_VERSION) {
    throw new Error(
      `unsupported TIA adapter conformance version: ${String(parsed.contractVersion)}`,
    )
  }
  if (parsed.protocolVersion !== TIA_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported TIA protocol version: ${String(parsed.protocolVersion)}`,
    )
  }

  if (!Array.isArray(parsed.features)) {
    throw new Error('TIA adapter features must be an array')
  }
  const features = parsed.features.map((feature, index) =>
    text(feature, `TIA adapter feature ${index}`),
  ) as TiaAdapterFeature[]
  if (features.some((feature) => !FEATURES.has(feature))) {
    throw new Error('TIA adapter receipt names an unsupported feature')
  }
  if (new Set(features).size !== features.length) {
    throw new Error('TIA adapter features contain duplicate values')
  }

  const environment = record(parsed.environment, 'TIA adapter environment')
  knownKeys(environment, ENVIRONMENT_KEYS, 'TIA adapter environment')
  const runner = record(parsed.runner, 'TIA adapter runner')
  knownKeys(runner, RUNNER_KEYS, 'TIA adapter runner')
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error('TIA adapter scenarios must be an array')
  }
  if (parsed.scenarios.length > TIA_ADAPTER_CONFORMANCE_SCENARIOS.length) {
    throw new Error('TIA adapter receipt has too many scenarios')
  }
  const knownScenarioIds = new Set(
    TIA_ADAPTER_CONFORMANCE_SCENARIOS.map(({ id }) => id),
  )
  const scenarios = parsed.scenarios.map((scenarioValue, index) => {
    const scenario = record(
      scenarioValue,
      `TIA adapter scenario result ${index}`,
    )
    knownKeys(scenario, SCENARIO_KEYS, `TIA adapter scenario result ${index}`)
    const id = text(scenario.id, `TIA adapter scenario result ${index} id`)
    if (!knownScenarioIds.has(id)) {
      throw new Error(`unknown TIA adapter conformance scenario: ${id}`)
    }
    if (typeof scenario.passed !== 'boolean') {
      throw new Error(`TIA adapter scenario ${id} passed must be a boolean`)
    }
    const evidence = record(
      scenario.evidence,
      `TIA adapter scenario ${id} evidence`,
    )
    knownKeys(evidence, EVIDENCE_KEYS, `TIA adapter scenario ${id} evidence`)
    return {
      evidence: {
        assertions: nonNegativeNumber(
          evidence.assertions,
          `TIA adapter scenario ${id} assertions`,
        ),
        ...(evidence.command === undefined
          ? {}
          : { command: text(evidence.command, `TIA adapter scenario ${id} command`) }),
        ...(evidence.durationMs === undefined
          ? {}
          : {
              durationMs: nonNegativeNumber(
                evidence.durationMs,
                `TIA adapter scenario ${id} durationMs`,
              ),
            }),
        fixture: text(evidence.fixture, `TIA adapter scenario ${id} fixture`),
      },
      id,
      passed: scenario.passed,
    }
  })
  if (new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) {
    throw new Error('TIA adapter scenarios contain duplicate values')
  }

  const generatedAt = text(parsed.generatedAt, 'TIA adapter generatedAt')
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('TIA adapter generatedAt must be an ISO timestamp')
  }
  const selectionGranularity = text(
    parsed.selectionGranularity,
    'TIA adapter selection granularity',
  ) as TiaAdapterCertificationReceipt['selectionGranularity']
  if (!GRANULARITIES.has(selectionGranularity)) {
    throw new Error(
      `unsupported TIA adapter selection granularity: ${selectionGranularity}`,
    )
  }
  if (
    capabilityLevel === 'runtime-tia' &&
    selectionGranularity !== 'test-case'
  ) {
    throw new Error('runtime TIA certification requires test-case selection')
  }
  if (
    capabilityLevel === 'observed-file-tia' &&
    selectionGranularity !== 'test-file'
  ) {
    throw new Error(
      'observed-file TIA certification requires test-file selection',
    )
  }

  return {
    adapter: text(parsed.adapter, 'TIA adapter name'),
    capabilityLevel,
    contractVersion: TIA_ADAPTER_CONFORMANCE_VERSION,
    environment: {
      architecture: text(
        environment.architecture,
        'TIA adapter environment architecture',
      ),
      operatingSystem: text(
        environment.operatingSystem,
        'TIA adapter environment operatingSystem',
      ),
    },
    features: [...features].sort(),
    generatedAt,
    protocolVersion: TIA_PROTOCOL_VERSION,
    runner: {
      name: text(runner.name, 'TIA adapter runner name'),
      version: text(runner.version, 'TIA adapter runner version'),
    },
    scenarios: [...scenarios].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    selectionGranularity,
    sourceRevision: text(parsed.sourceRevision, 'TIA adapter source revision'),
  }
}

export function certifyAdapterReceipt(
  value: unknown,
): TiaAdapterCertification {
  const receipt = parseAdapterCertificationReceipt(value)
  const required = requiredScenarioIds(
    receipt.capabilityLevel,
    receipt.features,
  )
  const results = new Map(
    receipt.scenarios.map((scenario) => [scenario.id, scenario]),
  )
  const missing = required.filter((id) => !results.has(id))
  if (missing.length > 0) {
    throw new Error(
      `TIA adapter certification is missing scenarios: ${missing.join(', ')}`,
    )
  }
  const failed = required.filter((id) => results.get(id)?.passed !== true)
  if (failed.length > 0) {
    throw new Error(
      `TIA adapter certification failed scenarios: ${failed.join(', ')}`,
    )
  }
  for (const id of required) {
    if ((results.get(id)?.evidence.assertions ?? 0) < 1) {
      throw new Error(
        `TIA adapter certification scenario ${id} has no assertions`,
      )
    }
  }

  return {
    adapter: receipt.adapter,
    capabilityLevel: receipt.capabilityLevel,
    features: receipt.features,
    passedScenarios: required.length,
    requiredScenarios: required,
    runner: `${receipt.runner.name}@${receipt.runner.version}`,
    sourceRevision: receipt.sourceRevision,
  }
}
