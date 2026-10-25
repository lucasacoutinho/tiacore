import { createInstrumenter } from 'istanbul-lib-instrument'
import { afterEach, describe, expect, test } from 'vitest'

import { installProbe } from '../../src/probe/index.ts'
import type { ProbeCoverageMap } from '../../src/probe/types.ts'
import { assertNoLeak } from '../support/leak.ts'

// The worker sends counters that advanced, never static maps, so a test's
// payload does not grow with the module count.

const VARIABLE = '__tiacore_probe_payload__'
const globals = globalThis as unknown as Record<string, unknown>

afterEach(() => {
  delete globals[VARIABLE]
  delete globals['__probe_call__']
})

const coverage = (): ProbeCoverageMap | undefined =>
  globals[VARIABLE] as ProbeCoverageMap | undefined

/** Loads `modules` files; the first one is the one tests call. */
function loadProject(modules: number, unusedFunctions: number): void {
  for (let index = 0; index < modules; index += 1) {
    const instrumenter = createInstrumenter({ coverageVariable: VARIABLE })
    const unused = Array.from(
      { length: unusedFunctions },
      (_, fn) => `function unused${fn}(v) { return v ? ${fn} : -${fn} }`,
    ).join('\n')
    const code = instrumenter.instrumentSync(
      `function used(v) { return v > 0 ? v : -v }\n${unused}\n${
        index === 0 ? 'globalThis.__probe_call__ = used\n' : ''
      }`,
      `/project/src/m${index}.js`,
    )
    new Function(code)()
  }
}

function payload(modules: number, unusedFunctions: number): string {
  delete globals[VARIABLE]
  loadProject(modules, unusedFunctions)
  const probe = installProbe(coverage)
  probe.beginTest('t')
  ;(globals['__probe_call__'] as (v: number) => number)(2)
  const window = probe.endTest('t')
  return JSON.stringify(window).replace(/"hash":"[0-9a-f]+"/u, '')
}

describe('probe payload', () => {
  test('is independent of the static map size', () => {
    expect(payload(1, 500)).toBe(payload(1, 1))
  })

  test('is independent of the number of instrumented modules', () => {
    const one = payload(1, 20)
    expect(payload(50, 20)).toBe(one)
    expect(payload(200, 20)).toBe(one)
  })

  test('carries counters, hashes and paths only', () => {
    loadProject(3, 5)
    const probe = installProbe(coverage)
    probe.beginTest('t')
    ;(globals['__probe_call__'] as (v: number) => number)(2)
    const window = probe.endTest('t')
    expect(Object.keys(window.coverage)).toEqual(['/project/src/m0.js'])
    expect(
      Object.keys(window.coverage['/project/src/m0.js'] ?? {}).sort(),
    ).toEqual(['b', 'f', 'hash', 's'])
    expect(JSON.stringify(window)).not.toMatch(/statementMap|fnMap|branchMap/u)
  })
})

describe('probe memory', () => {
  test('retains nothing per test, per gap or per module', async () => {
    loadProject(40, 10)
    const probe = installProbe(coverage)
    const call = globals['__probe_call__'] as (v: number) => number
    let tick = 0
    const result = await assertNoLeak(
      () => {
        tick += 1
        probe.beginTest(`t${tick}`)
        call(tick % 3)
        probe.endTest(`t${tick}`)
        if (tick % 10 === 0) probe.closeModule()
        if (tick % 7 === 0) probe.gap()
      },
      { bytesPerOperation: 64, iterations: 2_000 },
    )
    expect(result.bytesPerOperation).toBeLessThan(64)
  })

  test('forgets a module once its coverage map is gone', async () => {
    const result = await assertNoLeak(
      () => {
        delete globals[VARIABLE]
        loadProject(5, 5)
        const probe = installProbe(coverage)
        probe.beginTest('t')
        probe.endTest('t')
        probe.closeModule()
      },
      { bytesPerOperation: 256, iterations: 100 },
    )
    expect(result.bytesPerOperation).toBeLessThan(256)
  })

  test('does not accumulate across modules', async () => {
    loadProject(2, 2)
    const probe = installProbe(coverage)
    const call = globals['__probe_call__'] as (v: number) => number
    let tick = 0
    const result = await assertNoLeak(
      () => {
        tick += 1
        probe.beginTest(`t${tick}`)
        call(1)
        probe.endTest(`t${tick}`)
        probe.closeModule()
      },
      { bytesPerOperation: 64, iterations: 1_000 },
    )
    expect(result.bytesPerOperation).toBeLessThan(64)
  })
})
