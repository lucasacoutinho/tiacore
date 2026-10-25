import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'

import { installProbe } from '../../src/probe/index.ts'
import {
  addInto,
  deltaOf,
  denseOf,
  formatDelta,
  type Dense,
  type Increment,
  World,
} from '../support/coverage-world.ts'

const increment = Arbitrary.schema(
  Schema.Struct({
    by: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
    file: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
    kind: Schema.Literals(['s', 'f', 'b']),
    path: Schema.Int.check(Schema.isBetween({ maximum: 1, minimum: 0 })),
    slot: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  }),
)
const incrementList = Arbitrary.array(increment, { maxLength: 6 })

/** One step of a sequential module: some hits, then a gap or a test body. */
const step = Arbitrary.all({
  before: incrementList,
  body: incrementList,
  kind: Arbitrary.schema(Schema.Literals(['gap', 'test'])),
})
const trace = Arbitrary.array(step, { maxLength: 12 })

const hashes = (world: World): Map<string, string> =>
  new Map(Object.entries(world.coverage).map(([p, f]) => [p, f.hash]))

const apply = (world: World, list: readonly Increment[]) => {
  for (const item of list) world.apply(item)
}

/** `Acc.step` of proofs/Tia/Window.lean over dense snapshots. */
function reference(
  steps: readonly { before: Increment[]; body: Increment[]; kind: string }[],
) {
  const world = new World()
  const start = world.dense()
  let boundary: Dense = start
  const collection: Dense = new Map()
  const tests: Dense[] = []
  return {
    run() {
      for (const item of steps) {
        apply(world, item.before)
        const gap = world.dense()
        addInto(collection, deltaOf(boundary, gap))
        boundary = gap
        apply(world, item.body)
        const after = world.dense()
        if (item.kind === 'test') tests.push(deltaOf(boundary, after))
        else addInto(collection, deltaOf(boundary, after))
        boundary = after
      }
      return { collection, final: boundary, start, tests, world }
    },
  }
}

describe('coverage ledger', () => {
  it.prop(
    'matches the Window.lean reference and conserves every increment',
    [trace],
    ([steps]) => {
      const live = new World()
      const probe = installProbe(() => live.coverage)
      const ledgerTests: ReturnType<typeof probe.endTest>[] = []

      // Drive the probe and the reference over the same world: the probe
      // observes at the same boundaries the reference snapshots at.
      const driven = reference(steps)
      const sequence: (() => void)[] = []
      steps.forEach((item, index) => {
        sequence.push(() => {
          apply(live, item.before)
          if (item.kind === 'gap') {
            apply(live, item.body)
            probe.gap()
          } else {
            probe.beginTest(`t${index}`)
            apply(live, item.body)
            ledgerTests.push(probe.endTest(`t${index}`))
          }
        })
      })
      for (const run of sequence) run()
      const expected = driven.run()
      const module = probe.closeModule()

      // Per-window attribution (body_window): each test sees only its window.
      const expectedTests = expected.tests.map((delta) =>
        formatDelta(delta, hashes(expected.world)),
      )
      expect(ledgerTests.map((window) => window.coverage)).toEqual(
        expectedTests,
      )
      ledgerTests.forEach((window, index) => {
        expect(window.files).toEqual(
          Object.keys(expectedTests[index] ?? {}).sort(),
        )
      })

      // The collection window is everything that was not a test body.
      expect(module.collectionCoverage).toEqual(
        formatDelta(expected.collection, hashes(expected.world)),
      )

      // conservation: collection + sum of test deltas = the whole delta.
      const total: Dense = new Map()
      addInto(total, denseOf(module.collectionCoverage))
      for (const window of ledgerTests) addInto(total, denseOf(window.coverage))
      const whole = deltaOf(expected.start, expected.final)
      expect(new Map([...total].filter(([, count]) => count > 0))).toEqual(
        whole,
      )
      expect(module.concurrent).toBe(false)
      expect(module.files).toEqual(
        Object.keys(formatDelta(whole, hashes(expected.world))).sort(),
      )
    },
    { arbitrary: { runs: 400 } },
  )

  it.prop(
    'gives overlapping tests every counter advanced while they were open',
    [
      Arbitrary.array(
        Arbitrary.all({
          close: Arbitrary.schema(Schema.Boolean),
          hits: incrementList,
          open: Arbitrary.schema(Schema.Boolean),
        }),
        { maxLength: 14 },
      ),
    ],
    ([steps]) => {
      const live = new World()
      const probe = installProbe(() => live.coverage)
      const opened = new Map<string, Dense>()
      let next = 0
      const ids: string[] = []

      for (const item of steps) {
        if (item.open) {
          const id = `t${next++}`
          probe.beginTest(id, true)
          opened.set(id, live.dense())
          ids.push(id)
        }
        apply(live, item.hits)
        if (item.close && ids.length > 0) {
          const id = ids.shift() ?? ''
          const window = probe.endTest(id)
          const before = opened.get(id) ?? new Map()
          opened.delete(id)
          expect(denseOf(window.coverage)).toEqual(
            deltaOf(before, live.dense()),
          )
        }
      }
      for (const id of ids) probe.endTest(id)
      const module = probe.closeModule()
      const everything = deltaOf(new Map(), live.dense())
      expect(denseOf(module.collectionCoverage)).toEqual(everything)
      expect(module.collectionFiles).toEqual(module.files)
      expect(module.files).toEqual(
        Object.keys(formatDelta(everything, hashes(live))).sort(),
      )
      expect(module.concurrent).toBe(steps.some((item) => item.open))
    },
    { arbitrary: { runs: 300 } },
  )
})

describe('coverage ledger edges', () => {
  it('ignores counters that existed when it was installed', () => {
    const world = new World()
    world.apply({ by: 5, file: 0, kind: 's', path: 0, slot: 0 })
    const probe = installProbe(() => world.coverage)
    probe.beginTest('a')
    world.apply({ by: 2, file: 0, kind: 's', path: 0, slot: 0 })
    const window = probe.endTest('a')
    expect(Object.values(window.coverage)[0]?.s).toEqual({ 0: 2 })
    expect(probe.closeModule().collectionCoverage).toEqual({})
  })

  it('charges a file that appears mid-window from zero', () => {
    const world = new World()
    const probe = installProbe(world.coverage)
    probe.beginTest('a')
    world.apply({ by: 1, file: 1, kind: 'f', path: 0, slot: 1 })
    const window = probe.endTest('a')
    expect(window.files).toEqual(['/project/src/file1.ts'])
    expect(window.coverage['/project/src/file1.ts']?.f).toEqual({ 1: 1 })
    expect(window.coverage['/project/src/file1.ts']?.hash).toBe('hash1')
  })

  it('survives counters that go down and a deleted coverage map', () => {
    const world = new World()
    world.apply({ by: 3, file: 0, kind: 's', path: 0, slot: 0 })
    let present: World['coverage'] | undefined = world.coverage
    const probe = installProbe(() => present)
    probe.beginTest('a')
    const entry = world.coverage['/project/src/file0.ts']
    if (entry !== undefined) entry.s['0'] = 1
    expect(probe.endTest('a').coverage).toEqual({})
    probe.beginTest('b')
    if (entry !== undefined) entry.s['0'] = 2
    expect(probe.endTest('b').coverage['/project/src/file0.ts']?.s).toEqual({
      0: 1,
    })
    present = undefined
    probe.gap()
    present = world.coverage
    probe.beginTest('c')
    expect(probe.endTest('c').coverage).toEqual({})
    // The map came back with its counters; they are charged in full, to the
    // gap before the test, because nothing remembers the earlier boundary.
    expect(
      probe.closeModule().collectionCoverage['/project/src/file0.ts']?.s,
    ).toEqual({ 0: 2 })
  })

  it('charges a re-instrumented file in full', () => {
    const world = new World()
    world.apply({ by: 9, file: 0, kind: 's', path: 0, slot: 0 })
    const probe = installProbe(() => world.coverage)
    probe.beginTest('a')
    world.coverage['/project/src/file0.ts'] = {
      b: {},
      f: {},
      hash: 'other',
      path: '/project/src/file0.ts',
      s: { 0: 4 },
    }
    const window = probe.endTest('a')
    expect(window.coverage['/project/src/file0.ts']).toEqual({
      b: {},
      f: {},
      hash: 'other',
      s: { 0: 4 },
    })
  })

  it('keeps the path Istanbul reports over the map key', () => {
    const coverage = {
      'virtual:key': { hash: 'h', path: '/project/src/real.ts', s: { 0: 0 } },
    }
    const probe = installProbe(coverage)
    probe.beginTest('a')
    coverage['virtual:key'].s[0] = 1
    expect(Object.keys(probe.endTest('a').coverage)).toEqual([
      '/project/src/real.ts',
    ])
  })

  it('ignores an unknown test id and an absent coverage map', () => {
    const probe = installProbe(() => undefined)
    expect(probe.endTest('missing')).toEqual({ coverage: {}, files: [] })
    probe.beginTest('a')
    expect(probe.endTest('a')).toEqual({ coverage: {}, files: [] })
    expect(probe.closeModule()).toEqual({
      collectionCoverage: {},
      collectionFiles: [],
      concurrent: false,
      files: [],
    })
  })

  it('starts the next module afresh', () => {
    const world = new World()
    const probe = installProbe(() => world.coverage)
    world.apply({ by: 1, file: 0, kind: 's', path: 0, slot: 0 })
    expect(probe.closeModule().files).toEqual(['/project/src/file0.ts'])
    expect(probe.closeModule().files).toEqual([])
  })
})
