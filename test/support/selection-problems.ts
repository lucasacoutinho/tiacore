import type {
  Selection,
  SelectionGroup,
  SelectionItem,
  SelectionProblem,
} from '../../src/core/select.ts'

/** The Lean model's JSON encoding of a problem (proofs/Tia/Model.lean). */
export interface ModelProblem {
  items: {
    id: string
    group: string
    deps: string[]
    needs: string[]
    rerun: boolean
  }[]
  groups: {
    key: string
    file: string
    coarse: string[]
    exact: boolean
    rerun: boolean
  }[]
  known: string[]
  structural: string[]
  onUnknown: 'full' | 'ignore'
  changes: string[]
}

export type ModelSelection =
  | { full: { because: string } }
  | { only: { items: string[]; groups: string[] } }

const PATHS = [
  'a.test.ts',
  'b.test.ts',
  'lib/util.ts',
  'src/a.ts',
  'src/b.ts',
  'src/c.ts',
  'src/shared.ts',
]

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function generateProblems(seed: number, count: number): ModelProblem[] {
  const next = random(seed)
  const chance = (p: number) => next() < p
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(next() * values.length)] as T
  const subset = <T>(values: readonly T[], p: number): T[] =>
    values.filter(() => chance(p))

  return Array.from({ length: count }, () => {
    const groupKeys = Array.from(
      { length: Math.floor(next() * 4) },
      (_, index) => `g${index}`,
    )
    const itemIds = Array.from(
      { length: Math.floor(next() * 6) },
      (_, index) => `i${index}`,
    )
    const changes = subset(PATHS, 0.3)
    return {
      changes,
      groups: groupKeys.map((key) => ({
        coarse: subset(PATHS, 0.2),
        exact: chance(0.7),
        file: chance(0.6) ? pick(PATHS) : '',
        key,
        rerun: chance(0.1),
      })),
      items: itemIds.map((id) => ({
        deps: subset(PATHS, 0.25),
        group: groupKeys.length > 0 && chance(0.9) ? pick(groupKeys) : 'orphan',
        id,
        needs: subset(itemIds, 0.15),
        rerun: chance(0.1),
      })),
      known: subset(PATHS, 0.15),
      onUnknown: chance(0.7) ? 'full' : 'ignore',
      structural: subset(changes, 0.08),
    }
  })
}

export function fromModel(problem: ModelProblem): SelectionProblem {
  return {
    changes: problem.changes,
    groups: problem.groups.map((group): SelectionGroup => ({
      ...group,
      file: group.file === '' ? undefined : group.file,
    })),
    items: problem.items.map((item): SelectionItem => item),
    known: problem.known,
    onUnknown: problem.onUnknown,
    structural: new Map(
      problem.structural.map((path) => [path, 'invalidator']),
    ),
  }
}

/** Compares as sets: the model returns closure order, the kernel code-unit order. */
export function toModelSelection(selection: Selection): ModelSelection {
  if (selection._tag === 'Full') {
    return { full: { because: selection.cause.path } }
  }
  return {
    only: { groups: [...selection.groups], items: [...selection.items] },
  }
}

export function canonicalModelSelection(
  selection: ModelSelection,
): ModelSelection {
  if ('full' in selection) return selection
  return {
    only: {
      groups: [...new Set(selection.only.groups)].sort(),
      items: [...new Set(selection.only.items)].sort(),
    },
  }
}
