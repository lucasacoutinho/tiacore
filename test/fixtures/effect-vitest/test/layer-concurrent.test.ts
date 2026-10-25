import { appendFileSync } from 'node:fs'

import { layer } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { concurrentA } from '../src/concurrent-a.ts'
import { concurrentB } from '../src/concurrent-b.ts'

const log = (name: string) =>
  Effect.sync(() => appendFileSync('executions.log', `${name}\n`))

class Shared extends Context.Service<Shared, { readonly name: string }>()(
  'fixture/Shared',
) {}

const SharedLive = Layer.succeed(Shared, { name: 'shared' })

// Each test waits for the other, so both only finish when they overlap.
let arrived = 0
let bothArrived: () => void = () => {}
const meeting = new Promise<void>((resolve) => {
  bothArrived = resolve
})
const meet = Effect.promise(() => {
  arrived += 1
  if (arrived === 2) bothArrived()
  return meeting
})

// Tests of a concurrent block overlap, so their coverage cannot be split.
layer(SharedLive, { concurrent: true })('layer(L, { concurrent })', (it) => {
  it.effect('concurrent layer a', ({ expect }) =>
    Effect.gen(function* () {
      yield* log('concurrent-a')
      yield* meet
      const service = yield* Shared
      expect(`${service.name}:${concurrentA()}`).toBe('shared:a')
    }),
  )

  it.effect('concurrent layer b', ({ expect }) =>
    Effect.gen(function* () {
      yield* log('concurrent-b')
      yield* meet
      const service = yield* Shared
      expect(`${service.name}:${concurrentB()}`).toBe('shared:b')
    }),
  )
})
