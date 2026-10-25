import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import { select } from '../../src/core/select.ts'
import {
  canonicalModelSelection,
  fromModel,
  type ModelProblem,
  type ModelSelection,
  toModelSelection,
} from '../support/selection-problems.ts'

const vectors: {
  cases: { expected: ModelSelection; problem: ModelProblem }[]
} = JSON.parse(
  readFileSync(
    new URL('../../conformance/selection/v1/vectors.json', import.meta.url),
    'utf8',
  ),
)

const item = (
  id: string,
  overrides: Partial<ModelProblem['items'][number]> = {},
) => ({
  deps: [],
  group: id,
  id,
  needs: [],
  rerun: false,
  ...overrides,
})

const group = (
  key: string,
  overrides: Partial<ModelProblem['groups'][number]> = {},
) => ({
  coarse: [],
  exact: true,
  file: '',
  key,
  rerun: false,
  ...overrides,
})

const problem = (overrides: Partial<ModelProblem>): ModelProblem => ({
  changes: [],
  groups: [],
  items: [],
  known: [],
  onUnknown: 'full',
  structural: [],
  ...overrides,
})

describe('select', () => {
  test('matches every Lean-generated conformance vector', () => {
    expect(vectors.cases.length).toBeGreaterThan(0)
    for (const { expected, problem: input } of vectors.cases) {
      expect(toModelSelection(select(fromModel(input)))).toEqual(
        canonicalModelSelection(expected),
      )
    }
  })

  test('reports the first tripping change and why', () => {
    const result = select(
      fromModel(
        problem({
          changes: ['package.json', 'src/new.ts'],
          structural: ['package.json'],
        }),
      ),
    )
    expect(result).toEqual({
      _tag: 'Full',
      cause: {
        _tag: 'Structural',
        path: 'package.json',
        reason: 'invalidator',
      },
    })
  })

  test('explains dependency, whole-group and closure selections', () => {
    const result = select(
      fromModel(
        problem({
          changes: ['src/a.ts', 'a.test.ts'],
          groups: [group('a', { file: 'a.test.ts' }), group('b')],
          items: [
            item('a', { needs: ['b'] }),
            item('b'),
            item('c', { deps: ['src/a.ts'], group: 'b' }),
          ],
        }),
      ),
    )
    expect(result).toMatchObject({
      _tag: 'Only',
      groups: ['a'],
      items: ['a', 'b', 'c'],
    })
    if (result._tag !== 'Only') return
    expect(result.itemReasons.get('a')).toEqual([
      { _tag: 'Group', reason: { _tag: 'File', path: 'a.test.ts' } },
    ])
    expect(result.itemReasons.get('b')).toEqual([{ _tag: 'NeededBy', id: 'a' }])
    expect(result.itemReasons.get('c')).toEqual([
      { _tag: 'Dependency', path: 'src/a.ts' },
    ])
  })

  test('selects a whole group when per-item edges cannot explain a coarse change', () => {
    const result = select(
      fromModel(
        problem({
          changes: ['src/setup.ts'],
          groups: [group('file', { coarse: ['src/setup.ts'] })],
          items: [
            item('one', { group: 'file' }),
            item('two', { group: 'file' }),
          ],
        }),
      ),
    )
    expect(result).toMatchObject({ groups: ['file'], items: ['one', 'two'] })
  })

  test('selects nothing when nothing changed and nothing failed', () => {
    expect(
      toModelSelection(select(fromModel(problem({ items: [item('a')] })))),
    ).toEqual({ only: { groups: [], items: [] } })
  })
})
