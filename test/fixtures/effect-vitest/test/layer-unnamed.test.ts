import { appendFileSync } from 'node:fs'

import { layer } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { expect } from 'vitest'

import { buildUnnamed } from '../src/unnamed-build.ts'
import { unnamedA } from '../src/unnamed-a.ts'
import { unnamedB } from '../src/unnamed-b.ts'

const log = (name: string) =>
  Effect.sync(() => appendFileSync('executions.log', `${name}\n`))

class Unnamed extends Context.Service<Unnamed, { readonly name: string }>()(
  'fixture/Unnamed',
) {}

// Without a name there is no describe block: the layer is built in a
// beforeEach hook that the first test of the block triggers.
const UnnamedLive = Layer.effect(
  Unnamed,
  Effect.sync(() => ({ name: buildUnnamed() })),
)

layer(UnnamedLive)((it) => {
  it.effect('unnamed layer a', () =>
    Effect.gen(function* () {
      yield* log('unnamed-a')
      const service = yield* Unnamed
      expect(`${service.name}:${unnamedA()}`).toBe('unnamed:a')
    }),
  )

  it.effect('unnamed layer b', () =>
    Effect.gen(function* () {
      yield* log('unnamed-b')
      const service = yield* Unnamed
      expect(`${service.name}:${unnamedB()}`).toBe('unnamed:b')
    }),
  )
})
