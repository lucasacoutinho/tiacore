import { readFileSync } from 'node:fs'

import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'
import { Ajv2020 } from 'ajv/dist/2020.js'

import {
  parseArtifactEnvelope,
  parseImpactGraph,
} from '../../src/wire/decode.ts'

// The committed schemas in docs/protocol/schemas/ are what the Python and Go SDKs and third
// parties validate against. Anything the 2.0 decoder accepts must pass them,
// or tiacore would publish graphs its own schemas reject.

function committed(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../docs/protocol/schemas/${name}`, import.meta.url),
      'utf8',
    ),
  )
}

const ajv = new Ajv2020({ allErrors: false, strict: false })
const impact = committed('tiacore-impact-v1.schema.json')
ajv.addSchema(
  impact,
  'https://tiacore.dev/schemas/tiacore-impact-v1.schema.json',
)
const validateGraph = ajv.compile(impact)
const validateEnvelope = ajv.compile(
  committed('tiacore-artifact-envelope-v1.schema.json'),
)

function accepts(parse: (value: unknown) => unknown, value: unknown): boolean {
  try {
    parse(value)
    return true
  } catch {
    return false
  }
}

const text = Arbitrary.schema(
  Schema.Literals(['a', 'suite:a', 'z', ' padded ']),
)
const path = Arbitrary.schema(
  Schema.Literals(['src/a.ts', 'lib/b.ts', 'test/a.test.ts']),
)
const graph = Arbitrary.all({
  complete: Arbitrary.schema(Schema.Boolean),
  ids: Arbitrary.array(text, { maxLength: 3 }),
  knownSources: Arbitrary.array(path, { maxLength: 3 }),
  sources: Arbitrary.array(path, { maxLength: 3 }),
}).pipe(
  Arbitrary.map(({ complete, ids, knownSources, sources }) => ({
    complete,
    environmentFingerprint: '',
    fingerprint: 'project',
    knownSources,
    observations: ids.flatMap((id) =>
      sources.map((source) => ({
        confidence: 'observed',
        kind: 'executed',
        source,
        suiteId: id,
      })),
    ),
    protocolVersion: 1,
    suites: ids.map((id) => ({
      adapter: 'example',
      file: 'test/a.test.ts',
      id,
      project: 'p',
    })),
  })),
)

describe('committed JSON Schemas', () => {
  it.prop(
    'accept every impact graph the decoder accepts',
    [graph],
    ([candidate]) => {
      if (accepts(parseImpactGraph, candidate))
        expect(validateGraph(candidate)).toBe(true)
    },
    { arbitrary: { runs: 500 } },
  )

  it.prop(
    'accept every artifact envelope the decoder accepts',
    [graph],
    ([candidate]) => {
      const envelope = {
        adapter: 'vitest',
        artifactId: 'a1',
        graph: candidate,
        runId: 'r1',
      }
      if (accepts(parseArtifactEnvelope, envelope))
        expect(validateEnvelope(envelope)).toBe(true)
    },
    { arbitrary: { runs: 200 } },
  )

  it('reject every invalid conformance graph the schema can express', () => {
    const vectors: { vectors: { graph: unknown; name: string }[] } = JSON.parse(
      readFileSync(
        new URL(
          '../../docs/protocol/conformance/protocol/v1/invalid-graphs.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    // Cross-references (unknown suites, cycles) are beyond JSON Schema.
    const expressible = vectors.vectors.filter(
      ({ name }) => !/cycles|dangling/u.test(name),
    )
    for (const { graph: value, name } of expressible) {
      expect({ name, valid: validateGraph(value) }).toEqual({
        name,
        valid: false,
      })
    }
  })
})
