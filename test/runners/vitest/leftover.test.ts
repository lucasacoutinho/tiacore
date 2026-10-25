import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, test } from 'vitest'

import { installProbe } from '../../../src/probe/index.ts'
import {
  trackLeftoverWork,
  type LeftoverTracking,
} from '../../../src/runners/vitest/leftover.ts'
import { World, type Increment } from '../../support/coverage-world.ts'

// A detached Effect fiber forked by one test and finished during the next one.
// The fiber and the later test touch different files; the question is which
// window the fiber's file lands in. Real Effect, a synthetic `__coverage__`.

const LATE_FILE = 3
const OWN_FILE = 1
const FORKER_FILE = 0

const hit = (file: number): Increment => ({
  by: 1,
  file,
  kind: 's',
  path: 0,
  slot: 0,
})
const pathOf = World.pathOf

let tracking: LeftoverTracking | undefined
afterEach(() => {
  tracking?.stop()
  tracking = undefined
})

/** A promise and the function that settles it, so the order is not timing. */
const noop = () => {}

function latch() {
  let open: () => void = noop
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

interface Scenario {
  readonly forker: ReturnType<ReturnType<typeof installProbe>['endTest']>
  readonly module: ReturnType<ReturnType<typeof installProbe>['closeModule']>
  readonly neighbour: ReturnType<ReturnType<typeof installProbe>['endTest']>
}

/**
 * Test `forker` forks a detached fiber and ends. Test `neighbour` then runs,
 * touches its own file, and waits until the fiber has touched the late file.
 * `fiberSteps` is how many resumptions of the fiber touch the late file.
 */
async function run(options: {
  readonly forkOutsideTests?: boolean
  readonly steps?: number
  readonly track: boolean
}): Promise<Scenario> {
  const world = new World()
  const probe = installProbe(() => world.coverage)
  tracking = options.track ? trackLeftoverWork(probe) : undefined
  const scoped = <T>(id: string, body: () => T): T =>
    tracking === undefined || options.forkOutsideTests === true
      ? body()
      : tracking.run(id, body)
  const released = latch()
  const finished = latch()
  const steps = options.steps ?? 1

  const fiber = Effect.promise(() => released.opened).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        for (let step = 0; step < steps; step += 1) {
          yield* Effect.sleep(1)
          yield* Effect.sync(() => world.apply(hit(LATE_FILE)))
        }
        finished.open()
      }),
    ),
  )

  probe.beginTest('forker')
  await scoped('forker', async () => {
    world.apply(hit(FORKER_FILE))
    await Effect.runPromise(Effect.forkDetach(fiber).pipe(Effect.asVoid))
    await tick()
  })
  const forker = probe.endTest('forker')

  probe.beginTest('neighbour')
  await scoped('neighbour', async () => {
    world.apply(hit(OWN_FILE))
    released.open()
    await finished.opened
  })
  const neighbour = probe.endTest('neighbour')
  return { forker, module: probe.closeModule(), neighbour }
}

describe('leftover fiber work', () => {
  test('without tracking, a detached fiber is charged to the window it finishes in', async () => {
    const { forker, module, neighbour } = await run({ track: false })

    expect(forker.files).toEqual([pathOf(FORKER_FILE)])
    expect(neighbour.files).toEqual([pathOf(OWN_FILE), pathOf(LATE_FILE)])
    expect(module.collectionFiles).toEqual([])
  })

  test('charges a detached fiber of a finished test to collection, not to the running test', async () => {
    const { forker, module, neighbour } = await run({ track: true })

    expect(forker.files).toEqual([pathOf(FORKER_FILE)])
    expect(neighbour.files).toEqual([pathOf(OWN_FILE)])
    expect(module.collectionFiles).toEqual([pathOf(LATE_FILE)])
    expect(module.files).toEqual([
      pathOf(FORKER_FILE),
      pathOf(OWN_FILE),
      pathOf(LATE_FILE),
    ])
    expect(module.concurrent).toBe(false)
  })

  test('keeps the owner across every resumption of the fiber', async () => {
    const { module, neighbour } = await run({ steps: 3, track: true })

    expect(neighbour.files).toEqual([pathOf(OWN_FILE)])
    expect(module.collectionFiles).toEqual([pathOf(LATE_FILE)])
    expect(module.collectionCoverage[pathOf(LATE_FILE)]?.s).toEqual({ 0: 3 })
  })

  test('leaves work that no test started in the window it ran in', async () => {
    const { module, neighbour } = await run({
      forkOutsideTests: true,
      track: true,
    })

    expect(neighbour.files).toEqual([pathOf(OWN_FILE), pathOf(LATE_FILE)])
    expect(module.collectionFiles).toEqual([])
  })

  test('keeps a fiber that finishes inside its own test in that test', async () => {
    const world = new World()
    const probe = installProbe(() => world.coverage)
    tracking = trackLeftoverWork(probe)
    const done = latch()

    probe.beginTest('inside')
    await tracking?.run('inside', async () => {
      await Effect.runPromise(
        Effect.forkDetach(
          Effect.sleep(1).pipe(
            Effect.andThen(
              Effect.sync(() => {
                world.apply(hit(LATE_FILE))
                done.open()
              }),
            ),
          ),
        ).pipe(Effect.asVoid),
      )
      await done.opened
    })
    const inside = probe.endTest('inside')

    expect(inside.files).toEqual([pathOf(LATE_FILE)])
    expect(probe.closeModule().collectionFiles).toEqual([])
  })

  test('charges a fiber that finishes between tests to collection, as before', async () => {
    const world = new World()
    const probe = installProbe(() => world.coverage)
    tracking = trackLeftoverWork(probe)
    const released = latch()
    const finished = latch()

    probe.beginTest('forker')
    await tracking?.run('forker', () =>
      Effect.runPromise(
        Effect.forkDetach(
          Effect.promise(() => released.opened).pipe(
            Effect.andThen(
              Effect.sync(() => {
                world.apply(hit(LATE_FILE))
                finished.open()
              }),
            ),
          ),
        ).pipe(Effect.asVoid),
      ),
    )
    await tick()
    probe.endTest('forker')
    released.open()
    await finished.opened
    probe.beginTest('neighbour')
    const neighbour = probe.endTest('neighbour')

    expect(neighbour.files).toEqual([])
    expect(probe.closeModule().collectionFiles).toEqual([pathOf(LATE_FILE)])
  })

  test('stops classifying work once the tracking is stopped', async () => {
    const world = new World()
    const probe = installProbe(() => world.coverage)
    const first = trackLeftoverWork(probe)
    const done = latch()
    const released = latch()

    probe.beginTest('forker')
    await first?.run('forker', () =>
      Effect.runPromise(
        Effect.forkDetach(
          Effect.promise(() => released.opened).pipe(
            Effect.andThen(
              Effect.sync(() => {
                world.apply(hit(LATE_FILE))
                done.open()
              }),
            ),
          ),
        ).pipe(Effect.asVoid),
      ),
    )
    await tick()
    probe.endTest('forker')
    first?.stop()

    probe.beginTest('neighbour')
    released.open()
    await done.opened
    expect(probe.endTest('neighbour').files).toEqual([pathOf(LATE_FILE)])
  })
})

describe('the async context Effect keeps', () => {
  // The premise of leftover.ts: Effect 4 resumes a fiber inside the async
  // context it captured when the fiber was forked or yielded, not inside the
  // context of whoever settled the promise it waited for.
  test('resumes a detached fiber in the context of the code that forked it', async () => {
    const store = new AsyncLocalStorage<string>()
    const seen: string[] = []
    const released = latch()
    const finished = latch()

    await store.run('forker', () =>
      Effect.runPromise(
        Effect.forkDetach(
          Effect.promise(() => released.opened).pipe(
            Effect.andThen(
              Effect.sync(() => {
                seen.push(store.getStore() ?? 'none')
                finished.open()
              }),
            ),
            Effect.andThen(Effect.sleep(1)),
            Effect.andThen(
              Effect.sync(() => seen.push(store.getStore() ?? 'none')),
            ),
          ),
        ).pipe(Effect.asVoid),
      ),
    )
    await store.run('neighbour', async () => {
      released.open()
      await finished.opened
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(seen).toEqual(['forker', 'forker'])
  })
})

describe('the wrapped AsyncResource', () => {
  test('passes arguments, this, results and errors through', () => {
    const world = new World()
    const probe = installProbe(() => world.coverage)
    tracking = trackLeftoverWork(probe)
    const resource = new AsyncResource('tiacore-test')
    const owner = { name: 'this' }

    const result = resource.runInAsyncScope(
      function (this: typeof owner, a: number, b: number) {
        return `${this.name}:${a + b}`
      },
      owner,
      1,
      2,
    )

    expect(result).toBe('this:3')
    expect(() =>
      resource.runInAsyncScope(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
  })
})
