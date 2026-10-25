import { createInstrumenter } from 'istanbul-lib-instrument'
import { describe, expect, it } from '@effect/vitest'
import * as Arbitrary from 'effect/Arbitrary'
import * as Schema from 'effect/Schema'
import { afterEach } from 'vitest'

import { installProbe } from '../../src/probe/index.ts'
import type { ProbeCoverageMap } from '../../src/probe/types.ts'
import { legacy } from '../support/legacy.ts'

interface Legacy {
  coverageCounterDelta: (before: unknown, coverage: unknown) => unknown
  executedFilesSince: (before: unknown, coverage: unknown) => string[]
  mergeCoverageCounters: (...maps: unknown[]) => unknown
  snapshotCoverage: (coverage: unknown) => unknown
}

const runtime = await legacy<Legacy>('integrations/coverage/runtime.js')

const VARIABLE = '__tiacore_probe_differential__'
const globals = globalThis as unknown as Record<string, unknown>

afterEach(() => {
  delete globals[VARIABLE]
  delete globals['__probe_modules__']
})

const coverage = (): ProbeCoverageMap | undefined =>
  globals[VARIABLE] as ProbeCoverageMap | undefined

type Callable = (value: number) => number

function load(index: number): void {
  const instrumenter = createInstrumenter({ coverageVariable: VARIABLE })
  const functions = Array.from(
    { length: 4 },
    (_, fn) =>
      `function f${fn}(v) { if (v > ${fn}) { return v + ${fn} } else if (v < 0) { return -v } return v ? 1 : 0 }`,
  ).join('\n')
  const code = instrumenter.instrumentSync(
    `${functions}\n(globalThis.__probe_modules__ ??= {})[${index}] = [f0, f1, f2, f3]\n`,
    `/project/src/module${index}.js`,
  )
  new Function(code)()
}

function call(index: number, fn: number, value: number): void {
  const modules = globals['__probe_modules__'] as
    | Record<number, Callable[]>
    | undefined
  modules?.[index]?.[fn]?.(value)
}

const ActionSchema = Schema.Struct({
  fn: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  module: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  value: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: -2 })),
})
const action = Arbitrary.schema(ActionSchema)
const step = Arbitrary.all({
  before: Arbitrary.array(action, { maxLength: 3 }),
  body: Arbitrary.array(action, { maxLength: 4 }),
  kind: Arbitrary.schema(Schema.Literals(['gap', 'test'])),
})

const modules = (): Record<number, unknown> =>
  (globals['__probe_modules__'] as Record<number, unknown> | undefined) ?? {}

function run(actions: readonly (typeof ActionSchema.Type)[]): void {
  for (const item of actions) {
    if (globals[VARIABLE] === undefined || !(item.module in modules())) {
      load(item.module)
    }
    call(item.module, item.fn, item.value)
  }
}

let nonEmptyWindows = 0

describe('coverage ledger against 1.x on real Istanbul data', () => {
  it.prop(
    'reports what snapshotCoverage and coverageCounterDelta report',
    [Arbitrary.array(step, { maxLength: 10 })],
    ([steps]) => {
      delete globals[VARIABLE]
      delete globals['__probe_modules__']
      const probe = installProbe(coverage)

      // The setup file of 1.x, transcribed: a gap before every test, the test
      // window around the body, and a boundary after it.
      const baseline = runtime.snapshotCoverage(coverage())
      let boundary = baseline
      let collection: unknown = {}
      const collectionFiles = new Set<string>()
      const gap = () => {
        for (const file of runtime.executedFilesSince(boundary, coverage())) {
          collectionFiles.add(file)
        }
        collection = runtime.mergeCoverageCounters(
          collection,
          runtime.coverageCounterDelta(boundary, coverage()),
        )
        boundary = runtime.snapshotCoverage(coverage())
      }

      steps.forEach((item, index) => {
        run(item.before)
        if (item.kind === 'gap') {
          gap()
          probe.gap()
          run(item.body)
          return
        }
        gap()
        probe.beginTest(`t${index}`)
        const before = runtime.snapshotCoverage(coverage())
        run(item.body)
        const legacyWindow = {
          coverage: runtime.coverageCounterDelta(before, coverage()),
          files: runtime.executedFilesSince(before, coverage()),
        }
        boundary = runtime.snapshotCoverage(coverage())
        if (legacyWindow.files.length > 0) nonEmptyWindows += 1
        expect(probe.endTest(`t${index}`)).toEqual(legacyWindow)
      })

      gap()
      const module = probe.closeModule()
      expect(module.collectionCoverage).toEqual(collection)
      expect(module.collectionFiles).toEqual([...collectionFiles].sort())
      expect(module.files).toEqual(
        runtime.executedFilesSince(baseline, coverage()),
      )
    },
    { arbitrary: { runs: 150 } },
  )

  it('exercised windows that advanced counters', () => {
    expect(nonEmptyWindows).toBeGreaterThan(50)
  })
})
