import * as Schema from 'effect/Schema'

import {
  TIA_ADAPTER_CONFORMANCE_SCENARIOS,
  TIA_ADAPTER_CONFORMANCE_VERSION,
} from '../../core/conformance.ts'
import { TIA_PROTOCOL_VERSION } from '../../core/protocol.ts'
import { Text } from '../../wire/protocol.ts'

const knownScenarios = new Set(
  TIA_ADAPTER_CONFORMANCE_SCENARIOS.map(({ id }) => id),
)

export const CapabilityLevel = Schema.Literals([
  'observed-file-tia',
  'runtime-tia',
  'static-impact',
]).annotate({ message: 'is an unsupported TIA adapter capability level' })

export const Feature = Schema.Literals([
  'cached-outcomes',
  'coverage-reconstruction',
  'parallelism',
  'partitions',
  'subprocess-observation',
  'worktrees',
]).annotate({ message: 'names an unsupported feature' })

export const Granularity = Schema.Literals([
  'flow',
  'package',
  'profile',
  'test-case',
  'test-file',
]).annotate({ message: 'is an unsupported TIA adapter selection granularity' })

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

const distinct = <T>(key: (value: T) => string) =>
  Schema.makeFilter((values: readonly T[]) => {
    const seen = new Set<string>()
    for (const value of values) {
      const id = key(value)
      if (seen.has(id)) return 'contains duplicate values'
      seen.add(id)
    }
    return undefined
  })

const Evidence = Schema.Struct({
  assertions: NonNegative,
  command: Schema.optionalKey(Text),
  durationMs: Schema.optionalKey(NonNegative),
  fixture: Text,
})

const known = Schema.makeFilter(
  (id: string) =>
    knownScenarios.has(id) || `is not a conformance scenario: ${id}`,
)

const Scenario = Schema.Struct({
  evidence: Evidence,
  id: Text.check(known),
  passed: Schema.Boolean,
})

const isoTimestamp = Schema.makeFilter(
  (value: string) =>
    Number.isFinite(Date.parse(value)) || 'must be an ISO timestamp',
)

const granularityMatchesLevel = Schema.makeFilter(
  (receipt: {
    readonly capabilityLevel: string
    readonly selectionGranularity: string
  }) => {
    if (
      receipt.capabilityLevel === 'runtime-tia' &&
      receipt.selectionGranularity !== 'test-case'
    ) {
      return 'runtime TIA certification requires test-case selection'
    }
    if (
      receipt.capabilityLevel === 'observed-file-tia' &&
      receipt.selectionGranularity !== 'test-file'
    ) {
      return 'observed-file TIA certification requires test-file selection'
    }
    return undefined
  },
)

/**
 * The adapter certification receipt, as strict as the 1.x parser: closed
 * objects (the decoder runs with onExcessProperty: 'error'), the scenario cap,
 * known and unique scenario ids, and the level/granularity pairing that the
 * committed JSON Schema does not express.
 */
export const CertificationReceipt = Schema.Struct({
  adapter: Text,
  capabilityLevel: CapabilityLevel,
  contractVersion: Schema.Literal(TIA_ADAPTER_CONFORMANCE_VERSION).annotate({
    message: 'is an unsupported TIA adapter conformance version',
  }),
  environment: Schema.Struct({ architecture: Text, operatingSystem: Text }),
  features: Schema.mutable(Schema.Array(Feature)).check(
    distinct((feature: string) => feature),
  ),
  generatedAt: Text.check(isoTimestamp),
  protocolVersion: Schema.Literal(TIA_PROTOCOL_VERSION).annotate({
    message: 'is an unsupported TIA protocol version',
  }),
  runner: Schema.Struct({ name: Text, version: Text }),
  scenarios: Schema.mutable(Schema.Array(Scenario)).check(
    Schema.isMaxLength(TIA_ADAPTER_CONFORMANCE_SCENARIOS.length, {
      message: 'has too many scenarios',
    }),
    distinct((scenario: { readonly id: string }) => scenario.id),
  ),
  selectionGranularity: Granularity,
  sourceRevision: Text,
}).check(granularityMatchesLevel)
