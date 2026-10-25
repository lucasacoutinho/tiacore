import { appendFileSync } from 'node:fs'

import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect } from 'vitest'

import { detachedAfter } from '../src/detached-after.ts'
import { detachedInside } from '../src/detached-inside.ts'
import { detachedLater } from '../src/detached-later.ts'
import { detachedNeighbour } from '../src/detached-neighbour.ts'

const log = (name: string) =>
  Effect.sync(() => appendFileSync('executions.log', `${name}\n`))

/** A promise and the function that settles it, so the order is not timing. */
const noop = () => {}

function latch() {
  let open: () => void = noop
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const insideDone = latch()

// The detached fiber runs while the test body is still open.
it.live('detached fiber finishes inside the test', () =>
  Effect.gen(function* () {
    yield* log('detached-inside')
    yield* Effect.forkDetach(
      Effect.sync(() => {
        detachedInside()
        insideDone.open()
      }),
    )
    yield* Effect.promise(() => insideDone.opened)
  }),
)

describe('detached fiber that finishes between tests', () => {
  const release = latch()
  const afterDone = latch()

  // Runs after tiacore closed the test body, before the next test opens.
  afterEach(async () => {
    release.open()
    await afterDone.opened
  })

  it.live('detached fiber finishes after the test body', () =>
    Effect.gen(function* () {
      yield* log('detached-after')
      yield* Effect.forkDetach(
        Effect.promise(() => release.opened).pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              detachedAfter()
              afterDone.open()
            }),
          ),
        ),
      )
    }),
  )
})

const laterRelease = latch()
const laterDone = latch()
let laterForked = false

it.live('detached fiber finishes during a later test', () =>
  Effect.gen(function* () {
    yield* log('detached-fork')
    laterForked = true
    yield* Effect.forkDetach(
      Effect.promise(() => laterRelease.opened).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            detachedLater()
            laterDone.open()
          }),
        ),
      ),
    )
  }),
)

// Lets the fiber of the previous test run, and does not end before it did. A
// run that replays the previous test has no such fiber to wait for.
it.live('test that is running while the detached fiber finishes', () =>
  Effect.gen(function* () {
    yield* log('detached-neighbour')
    if (laterForked) {
      laterRelease.open()
      yield* Effect.promise(() => laterDone.opened)
    }
    expect(detachedNeighbour()).toBe('neighbour')
  }),
)
