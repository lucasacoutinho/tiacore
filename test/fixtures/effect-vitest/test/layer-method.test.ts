import { appendFileSync } from 'node:fs'

import { it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { expect } from 'vitest'

import { buildInner } from '../src/method-inner-build.ts'
import { innerCase } from '../src/method-inner.ts'
import { buildOuter } from '../src/method-outer-build.ts'
import { outerCase } from '../src/method-outer.ts'

const log = (name: string) =>
  Effect.sync(() => appendFileSync('executions.log', `${name}\n`))

class Outer extends Context.Service<Outer, { readonly name: string }>()(
  'fixture/Outer',
) {}
class Inner extends Context.Service<Inner, { readonly name: string }>()(
  'fixture/Inner',
) {}

const OuterLive = Layer.effect(
  Outer,
  Effect.sync(() => ({ name: buildOuter() })),
)
const InnerLive = Layer.effect(
  Inner,
  Effect.sync(() => ({ name: buildInner() })),
)

it.layer(OuterLive)('it.layer(L)(name, f)', (outer) => {
  outer.effect('outer layer case', () =>
    Effect.gen(function* () {
      yield* log('method-outer')
      const service = yield* Outer
      expect(`${service.name}:${outerCase()}`).toBe('outer:outer')
    }),
  )

  // A nested layer without a name builds on the first test that needs it.
  outer.layer(InnerLive)((inner) => {
    inner.effect('inner layer case', () =>
      Effect.gen(function* () {
        yield* log('method-inner')
        const outerService = yield* Outer
        const innerService = yield* Inner
        expect(`${outerService.name}:${innerService.name}:${innerCase()}`).toBe(
          'outer:inner:inner',
        )
      }),
    )
  })
})
