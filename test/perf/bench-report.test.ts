import { describe, expect, test } from 'vitest'

import {
  collect,
  compareSamples,
  ms,
  parseRun,
  ratio,
  renderComparison,
  summarize,
  versus,
  type BenchRecord,
} from '../support/bench-report.ts'
import { interleave } from '../support/bench-run.ts'
import { exactMedian, mad } from '../support/stats.ts'

// The statistics and the noise rule behind `npm run bench` (test/perf/bench.ts).

const run = (
  samples: readonly number[],
  rounds = samples.length,
): BenchRecord => ({
  meta: {
    arch: 'x64',
    commit: 'abc1234',
    cpus: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    dirty: false,
    legacyVersion: '1.2.1',
    node: 'v24.0.0',
    platform: 'linux',
    rounds,
    version: '2.0.0',
  },
  schema: 1,
  workloads: {
    w: {
      metrics: { m: { samples, unit: 'ms' } },
      rounds,
      seconds: 1,
    },
  },
})

describe('summaries', () => {
  test('the median of an even count is the mean of the middle two', () => {
    expect(exactMedian([4, 1, 3, 2])).toBe(2.5)
    expect(exactMedian([5, 1, 3])).toBe(3)
  })

  test('the MAD ignores one wild round', () => {
    expect(summarize([10, 11, 9, 10, 500])).toEqual({
      mad: 1,
      median: 10,
      min: 9,
    })
    expect(mad([7, 7, 7])).toBe(0)
  })
})

describe('the noise rule', () => {
  test('a change within twice the combined MAD is noise', () => {
    // MAD 1 on both sides: a median that moved by 3.5 is below 2 x (1 + 1).
    const result = compareSamples(
      [10, 11, 9, 10, 12],
      [13.5, 14.5, 12.5, 13.5, 15.5],
    )
    expect(result.delta).toBe(3.5)
    expect(result.noise).toBe(4)
    expect(result.verdict).toBe('noise')
  })

  test('a larger drop is a win and a larger rise is a loss', () => {
    const base = [100, 101, 99, 100, 102]
    expect(compareSamples(base, [50, 51, 49, 50, 52]).verdict).toBe('win')
    expect(compareSamples(base, [150, 151, 149, 150, 152]).verdict).toBe('loss')
  })

  test('without any spread every difference counts', () => {
    expect(compareSamples([5, 5, 5], [5, 5, 5]).verdict).toBe('noise')
    expect(compareSamples([5, 5, 5], [6, 6, 6]).verdict).toBe('loss')
  })

  test('the comparison counts wins and losses per metric and skips the rest', () => {
    const saved = run([100, 101, 99, 100, 102])
    const faster = run([50, 51, 49, 50, 52])
    const { tally, text } = renderComparison(saved, faster)
    expect(tally).toEqual({ losses: 0, wins: 1 })
    expect(text).toContain('WIN')

    const other: BenchRecord = {
      ...faster,
      workloads: {
        w: {
          ...(faster.workloads['w'] ?? { rounds: 5, seconds: 1 }),
          metrics: { fresh: { samples: [1, 2, 3], unit: 'ms' } },
        },
      },
    }
    const skipped = renderComparison(saved, other)
    expect(skipped.tally).toEqual({ losses: 0, wins: 0 })
    expect(skipped.text).toContain('w/fresh: not in the saved run')
    expect(skipped.text).toContain('w/m: not in this run')
  })
})

describe('rounds and files', () => {
  test('rounds fold into one record per metric, 2.0 / 1.x per round', () => {
    const metrics = collect([
      versus('plan', 10, 20),
      versus('plan', 30, 20),
      { extra: ms(1) },
    ])
    expect(metrics['plan']?.samples).toEqual([10, 30])
    expect(metrics['plan.v1']?.samples).toEqual([20, 20])
    expect(metrics['plan.ratio']).toEqual({ samples: [0.5, 1.5], unit: 'x' })
    expect(metrics['extra']?.samples).toEqual([1])
  })

  test('a metric cannot change unit or be unmeasured', () => {
    expect(() => collect([{ a: ms(1) }, { a: ratio(1) }])).toThrow(/unit/u)
    expect(() => collect([{ a: ms(Number.NaN) }])).toThrow(/measured NaN/u)
  })

  test('a saved run reads back and a foreign file is refused', () => {
    const saved = run([1, 2, 3])
    expect(parseRun(JSON.stringify(saved))).toEqual(saved)
    expect(() => parseRun('{"schema":2}')).toThrow(/Missing key/u)
    expect(() => parseRun('[]')).toThrow(/Expected object/u)
  })

  test('the contenders take turns going first', () => {
    expect(interleave(['a', 'b'], 0)).toEqual(['a', 'b'])
    expect(interleave(['a', 'b'], 1)).toEqual(['b', 'a'])
    expect(interleave(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a'])
  })
})
