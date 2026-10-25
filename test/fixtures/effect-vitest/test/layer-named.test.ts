import { appendFileSync } from 'node:fs'

import { layer } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { expect } from 'vitest'

import { buildNamed } from '../src/named-build.ts'
import { namedA } from '../src/named-a.ts'
import { namedB } from '../src/named-b.ts'

const log = (name: string) =>
  Effect.sync(() => appendFileSync('executions.log', `${name}\n`))

class Named extends Context.Service<Named, { readonly name: string }>()(
  'fixture/Named',
) {}

// The layer is built once, in the describe block's beforeAll hook.
const NamedLive = Layer.effect(
  Named,
  Effect.sync(() => ({ name: buildNamed() })),
)

layer(NamedLive)('layer(L)(name, f)', (it) => {
  it.effect('named layer a', () =>
    Effect.gen(function* () {
      yield* log('named-a')
      const service = yield* Named
      expect(`${service.name}:${namedA()}`).toBe('named:a')
    }),
  )

  it.effect('named layer b', () =>
    Effect.gen(function* () {
      yield* log('named-b')
      const service = yield* Named
      expect(`${service.name}:${namedB()}`).toBe('named:b')
    }),
  )
})
