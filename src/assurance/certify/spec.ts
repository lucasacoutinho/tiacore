import * as Schema from 'effect/Schema'

import type { TiaExecutableCertificationOptions } from './execute.ts'
import { CapabilityLevel, Feature, Granularity } from './receipt.ts'

const Scenario = Schema.Struct({
  arguments: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  assertions: Schema.optionalKey(Schema.Finite),
  command: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  fixture: Schema.String,
  id: Schema.String,
  timeoutMs: Schema.optionalKey(Schema.Finite),
})

/** The `certify execute --spec` document. */
export const ExecutableSpec: Schema.Codec<TiaExecutableCertificationOptions> =
  Schema.Struct({
    adapter: Schema.String,
    capabilityLevel: CapabilityLevel,
    features: Schema.optionalKey(Schema.mutable(Schema.Array(Feature))),
    root: Schema.optionalKey(Schema.String),
    runner: Schema.Struct({ name: Schema.String, version: Schema.String }),
    scenarios: Schema.mutable(Schema.Array(Scenario)),
    selectionGranularity: Granularity,
    sourceRevision: Schema.String,
  })
