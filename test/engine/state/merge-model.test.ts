import { createHash } from 'node:crypto'

import { describe, expect, test } from 'vitest'

import type { TiaRuntimeGraph } from '../../../src/core/runtime.ts'
import { mergePartitionedGraphs } from '../../../src/engine/state/merge.ts'
import { baseGraph } from '../support/graphs.ts'

// Differential test of the partition merge against proofs/Tia/Merge.lean.
// `Frag`, `accepts`, `ambiguous`, `coversAll`, `addRec`, `mergeAll` and
// `mergeFrags` below are transcribed from the model line for line. The
// theorems it proves (mergeAll_spec, mergeAll_conflict, merge_complete,
// merge_missing) are then checked as properties of the TypeScript merge.
//
// Known gap: the model accepts total = 0 vacuously (every index is covered);
// the TypeScript merge rejects it, so the generator draws total from 1..4.

interface Frag {
  baseline: string
  complete: boolean
  covComplete: boolean
  edges: Array<[string, number]>
  fingerprint: string
  gen: number
  group: string
  index: number
  total: number
}

const accepts = (f0: Frag, f: Frag): boolean =>
  f.total === f0.total &&
  f.group === f0.group &&
  !f.complete &&
  f.fingerprint === f0.fingerprint &&
  f.baseline === f0.baseline &&
  1 <= f.index &&
  f.index <= f0.total

const ambiguous = (vs: Frag[]): boolean =>
  vs.some((a) => vs.some((b) => a.index === b.index && a.gen !== b.gen))

const coversAll = (vs: Frag[], total: number): boolean =>
  Array.from({ length: total }, (_, i) => i).every((i) =>
    vs.some((f) => f.index === i + 1),
  )

function mergeAll(xs: Array<[string, number]>): Array<[string, number]> | null {
  const acc: Array<[string, number]> = []
  for (const [key, value] of xs) {
    const found = acc.find(([k]) => k === key)
    if (found === undefined) acc.push([key, value])
    else if (found[1] !== value) return null
  }
  return acc
}

function mergeFrags(
  fs: Frag[],
): { covComplete: boolean; edges: Array<[string, number]> } | null {
  const f0 = fs[0]
  if (f0 === undefined) return null
  const vs = fs.filter((f) => accepts(f0, f))
  if (ambiguous(vs) || !coversAll(vs, f0.total)) return null
  const edges = mergeAll(vs.flatMap((f) => f.edges))
  return edges === null
    ? null
    : { covComplete: vs.every((f) => f.covComplete), edges }
}

function toGraph(frag: Frag): TiaRuntimeGraph {
  return baseGraph({
    baseline: { sha: frag.baseline, workingTree: {} },
    complete: frag.complete,
    coverageComplete: frag.covComplete,
    edges: Object.fromEntries(
      frag.edges.map(([key, value]) => [key, [`v${value}`]]),
    ),
    fingerprint: frag.fingerprint,
    partition: { group: frag.group, index: frag.index, total: frag.total },
    results: {},
    testEdges: {},
    updatedAt: `gen-${frag.gen}`,
  })
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fragments with the same index and variant are identical, as one generation means one graph. */
function fragmentOf(
  index: number,
  total: number,
  variant: number,
  identity: Pick<Frag, 'baseline' | 'fingerprint' | 'group'>,
  complete: boolean,
  conflicting: boolean,
): Frag {
  const edges: Array<[string, number]> = []
  for (let key = 0; key < 4; key += 1) {
    if ((index * 7 + variant * 3 + key) % 3 !== 0) {
      edges.push([`k${key}`, conflicting ? (index + variant + key) % 2 : key])
    }
  }
  const covComplete = (index + variant) % 2 === 0
  const gen = Number.parseInt(
    createHash('sha256')
      .update(JSON.stringify([index, variant, covComplete, edges, complete]))
      .digest('hex')
      .slice(0, 8),
    16,
  )
  return { ...identity, complete, covComplete, edges, gen, index, total }
}

function randomCase(random: () => number): Frag[] {
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)]!
  const total = 1 + Math.floor(random() * 4)
  const identity = { baseline: 'b', fingerprint: 'f', group: 'g' }
  const conflicting = random() < 0.25
  const list: Frag[] = []
  for (let index = 1; index <= total; index += 1) {
    if (random() < 0.85) {
      list.push(fragmentOf(index, total, 0, identity, false, conflicting))
    }
    if (random() < 0.2) {
      list.push(
        fragmentOf(index, total, pick([0, 1]), identity, false, conflicting),
      )
    }
  }
  const strangers = Math.floor(random() * 3)
  for (let n = 0; n < strangers; n += 1) {
    const index = pick([0, 1, 2, 3, 4, 5, total])
    const kind = pick([
      'total',
      'group',
      'fingerprint',
      'baseline',
      'complete',
      'plain',
    ])
    list.push({
      ...fragmentOf(
        index,
        kind === 'total' ? total + 1 : total,
        pick([0, 1]),
        {
          baseline: kind === 'baseline' ? 'B' : identity.baseline,
          fingerprint: kind === 'fingerprint' ? 'F' : identity.fingerprint,
          group: kind === 'group' ? 'G' : identity.group,
        },
        kind === 'complete',
        conflicting,
      ),
    })
  }
  for (let i = list.length - 1; i > 0 && random() < 0.5; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[list[i], list[j]] = [list[j]!, list[i]!]
  }
  return list
}

describe('partition merge against proofs/Tia/Merge.lean', () => {
  test('agrees with mergeFrags on random fragment sets', () => {
    const random = mulberry32(0x7a11)
    let merged = 0
    let rejected = 0
    for (let run = 0; run < 20_000; run += 1) {
      const frags = randomCase(random)
      const model = mergeFrags(frags)
      const actual = mergePartitionedGraphs(frags.map(toGraph))
      if (model === null) {
        rejected += 1
        expect(actual, JSON.stringify(frags)).toBeNull()
        continue
      }
      merged += 1
      expect(actual, JSON.stringify(frags)).not.toBeNull()
      expect(actual?.complete).toBe(true)
      expect(actual?.coverageComplete).toBe(model.covComplete)
      expect(actual?.partition).toBeUndefined()
      // mergeAll_spec: nothing lost, nothing invented, one value per key.
      expect(
        Object.entries(actual?.edges ?? {}).map(([key, value]) => [
          key,
          Number(value[0]!.slice(1)),
        ]),
      ).toEqual(expect.arrayContaining(model.edges))
      expect(Object.keys(actual?.edges ?? {}).length).toBe(model.edges.length)
    }
    // Both branches must be well represented for the comparison to mean much.
    expect(merged).toBeGreaterThan(2_000)
    expect(rejected).toBeGreaterThan(2_000)
  })

  test('mergeAll_conflict: two values for one key are never resolved', () => {
    const a = fragmentOf(
      1,
      2,
      0,
      { baseline: 'b', fingerprint: 'f', group: 'g' },
      false,
      false,
    )
    const b = fragmentOf(
      2,
      2,
      0,
      { baseline: 'b', fingerprint: 'f', group: 'g' },
      false,
      false,
    )
    b.edges = [['k1', 99], ...b.edges.filter(([key]) => key !== 'k1')]
    a.edges = [['k1', 1], ...a.edges.filter(([key]) => key !== 'k1')]
    expect(mergeFrags([a, b])).toBeNull()
    expect(mergePartitionedGraphs([a, b].map(toGraph))).toBeNull()
  })

  test('merge_missing: an absent index is a rejection', () => {
    const identity = { baseline: 'b', fingerprint: 'f', group: 'g' }
    const frags = [
      fragmentOf(1, 3, 0, identity, false, false),
      fragmentOf(3, 3, 0, identity, false, false),
    ]
    expect(mergeFrags(frags)).toBeNull()
    expect(mergePartitionedGraphs(frags.map(toGraph))).toBeNull()
  })
})
