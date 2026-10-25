import { appendFileSync } from 'node:fs'

import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'

import { basicEffect } from '../src/basic-effect.ts'
import { effectPropLaw } from '../src/basic-effect-prop.ts'
import { basicLive } from '../src/basic-live.ts'
import { propLaw } from '../src/basic-prop.ts'
import { acquireResource, releaseResource } from '../src/basic-scoped.ts'

const log = (name: string) =>
  Effect.sync(() => appendFileSync('executions.log', `${name}\n`))

it.effect('it.effect', () =>
  Effect.gen(function* () {
    yield* log('effect')
    expect(basicEffect()).toBe('effect')
  }),
)

it.live('it.live', () =>
  Effect.gen(function* () {
    yield* log('live')
    yield* Effect.sleep(5)
    expect(basicLive()).toBe('live')
  }),
)

// `it.effect` provides a Scope, so a scoped resource is acquired and released
// inside the test body.
it.effect('it.effect with a scoped resource', () =>
  Effect.gen(function* () {
    yield* log('scoped')
    const resource = yield* Effect.acquireRelease(
      Effect.sync(() => acquireResource()),
      () => Effect.sync(() => releaseResource()),
    )
    expect(resource).toBe('resource')
  }),
)

it.prop('it.prop', { n: Schema.Int }, ({ n }) => {
  appendFileSync('executions.log', 'prop\n')
  return propLaw() && Number.isInteger(n)
})

it.effect.prop('it.effect.prop', { n: Schema.Int }, ({ n }) =>
  Effect.gen(function* () {
    yield* log('effect-prop')
    return effectPropLaw() && Number.isInteger(n)
  }),
)
