// Validates the shipped capabilities/adapter-capabilities-v1.json for
// test/assurance/capabilities.test.ts. Nothing in the package reads that file.

import * as Schema from 'effect/Schema'

import type {
  TiaAdapterCapabilityLevel,
  TiaAdapterSelectionGranularity,
} from '../../src/core/conformance.ts'
import { valueOrThrow } from '../../src/wire/issue.ts'

export interface AdapterCapability {
  baselines: Array<'explicit-changes' | 'filesystem' | 'git'>
  boundaries: string[]
  cachedOutcomes: boolean
  capabilityLevel: TiaAdapterCapabilityLevel
  coverageReconstruction: boolean
  dependencyEvidence: 'runtime' | 'runtime-and-static' | 'static'
  entryPoint: string
  factory: string | null
  id: string
  nativeParallelism: boolean
  selectionGranularity: TiaAdapterSelectionGranularity
}

export interface AdapterCapabilityContract {
  $schema?: string
  adapters: AdapterCapability[]
  contractVersion: 1
}

const Name = Schema.NonEmptyString

const unique = Schema.makeFilter((values: readonly string[]) =>
  new Set(values).size === values.length ? undefined : 'contains duplicates',
)

const levelRules = Schema.makeFilter((adapter: AdapterCapability) => {
  if (adapter.capabilityLevel === 'runtime-tia') {
    return (
      (adapter.dependencyEvidence === 'runtime' &&
        adapter.cachedOutcomes &&
        adapter.selectionGranularity === 'test-case' &&
        adapter.factory === 'tia') ||
      `${adapter.id}: runtime-tia needs runtime evidence, cached outcomes, test-case selection and the tia factory`
    )
  }
  if (adapter.capabilityLevel === 'static-impact') {
    return (
      (adapter.dependencyEvidence === 'static' &&
        !adapter.cachedOutcomes &&
        !adapter.coverageReconstruction) ||
      `${adapter.id}: static-impact needs static evidence and no cached outcomes or coverage`
    )
  }
  return undefined
})

const Adapter = Schema.Struct({
  baselines: Schema.mutable(
    Schema.Array(Schema.Literals(['filesystem', 'git', 'explicit-changes'])),
  ).check(Schema.isMinLength(1), unique),
  boundaries: Schema.mutable(Schema.Array(Name)).check(Schema.isMinLength(1)),
  cachedOutcomes: Schema.Boolean,
  capabilityLevel: Schema.Literals([
    'runtime-tia',
    'observed-file-tia',
    'static-impact',
  ]),
  coverageReconstruction: Schema.Boolean,
  dependencyEvidence: Schema.Literals([
    'runtime',
    'runtime-and-static',
    'static',
  ]),
  entryPoint: Name,
  factory: Schema.NullOr(Schema.String),
  id: Name,
  nativeParallelism: Schema.Boolean,
  selectionGranularity: Schema.Literals([
    'test-case',
    'test-file',
    'package',
    'profile',
    'flow',
  ]),
}).check(levelRules)

const Contract = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  adapters: Schema.mutable(Schema.Array(Adapter)).check(
    Schema.isMinLength(1),
    Schema.makeFilter((adapters: readonly AdapterCapability[]) =>
      new Set(adapters.map(({ id }) => id)).size === adapters.length
        ? undefined
        : 'contains duplicate adapter ids',
    ),
  ),
  contractVersion: Schema.Literal(1),
})

const decode = Schema.decodeUnknownExit(Contract)

/** Validates the adapter capability document against its contract rules. */
export function parseAdapterCapabilities(
  value: unknown,
): AdapterCapabilityContract {
  return valueOrThrow(
    'TIA adapter capabilities',
    decode(value, { onExcessProperty: 'error' }),
  )
}
