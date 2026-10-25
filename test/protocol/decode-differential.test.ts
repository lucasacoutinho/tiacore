import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'

import { parseImpactGraph } from '../../src/wire/decode.ts'
import { legacy } from '../support/legacy.ts'

const legacyValidate = await legacy<{
  parseImpactGraph: (value: unknown) => unknown
}>('protocol/validate.js')

const id = Arbitrary.schema(Schema.Literals(['s1', 's2', 's3', '']))
const path = Arbitrary.schema(
  Schema.Literals([
    'src/a.ts',
    './src/a.ts',
    'src\\b.ts',
    'lib/c.ts',
    '/abs.ts',
    '../out.ts',
  ]),
)
const suite = Arbitrary.all({
  dependsOn: Arbitrary.array(id, { maxLength: 2 }),
  file: path,
  id,
  withDependsOn: Arbitrary.schema(Schema.Boolean),
})
const observation = Arbitrary.all({
  confidence: Arbitrary.schema(
    Schema.Literals(['exact', 'observed', 'guessed']),
  ),
  kind: Arbitrary.schema(Schema.Literals(['import', 'executed'])),
  source: path,
  suiteId: id,
})
const graph = Arbitrary.all({
  extraField: Arbitrary.schema(Schema.Boolean),
  knownSources: Arbitrary.array(path, { maxLength: 3 }),
  observations: Arbitrary.array(observation, { maxLength: 4 }),
  suites: Arbitrary.array(suite, { maxLength: 3 }),
  version: Arbitrary.schema(Schema.Literals([1, 1, 1, 2])),
}).pipe(
  Arbitrary.map((input) => ({
    complete: true,
    environmentFingerprint: '',
    fingerprint: 'project',
    knownSources: input.knownSources,
    observations: input.observations,
    protocolVersion: input.version,
    suites: input.suites.map(
      ({ dependsOn, file, id: suiteId, withDependsOn }) => ({
        adapter: 'example',
        ...(withDependsOn ? { dependsOn } : {}),
        file,
        id: suiteId,
        project: 'example',
      }),
    ),
    ...(input.extraField ? { unexpected: true } : {}),
  })),
)

// Sorts object keys and array items so that only content is compared: 1.x
// sorts with localeCompare and builds objects in a different key order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .sort((left, right) =>
        JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
      )
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    )
  }
  return value
}

function outcome(parse: (value: unknown) => unknown, value: unknown): unknown {
  try {
    return canonical(parse(value))
  } catch {
    return 'rejected'
  }
}

describe('parseImpactGraph', () => {
  it.prop(
    'accepts and canonicalizes exactly the graphs 1.x accepts',
    [graph],
    ([candidate]) => {
      expect(outcome(parseImpactGraph, candidate)).toEqual(
        outcome(legacyValidate.parseImpactGraph, candidate),
      )
    },
    { arbitrary: { runs: 500 } },
  )
})
