// Implements proofs/Tia/Model.lean `Problem.select`, indexed instead of list-scanning, and
// additionally reports why each item and group was chosen. `progress` in
// proofs/Tia/Progress.lean shows the closure always converges, so there is no
// non-convergence branch.

export interface SelectionItem {
  readonly id: string
  /** Key of the group the item belongs to. */
  readonly group: string
  /** Recorded dependencies of the item itself. */
  readonly deps: readonly string[]
  /** Items that must also run when this one runs. */
  readonly needs: readonly string[]
  /** A previous failure that must run again. */
  readonly rerun: boolean
}

export interface SelectionGroup {
  readonly key: string
  /** A changed path equal to this file selects the whole group. */
  readonly file: string | undefined
  /** Group-level dependencies, such as a test file's module-level edges. */
  readonly coarse: readonly string[]
  /** False when per-item edges are incomplete for this group. */
  readonly exact: boolean
  /** A whole-group failure that must run again. */
  readonly rerun: boolean
}

export interface SelectionProblem {
  readonly items: readonly SelectionItem[]
  readonly groups: readonly SelectionGroup[]
  /** Paths known to be unrelated to every item, in addition to all recorded paths. */
  readonly known: Iterable<string>
  /** Changed paths that matched an invalidator, with the invalidator's reason. */
  readonly structural: ReadonlyMap<string, string>
  readonly onUnknown: 'full' | 'ignore'
  /** Normalized changed paths in the order the caller wants trips reported. */
  readonly changes: readonly string[]
}

export type FullCause =
  | {
      readonly _tag: 'Structural'
      readonly path: string
      readonly reason: string
    }
  | { readonly _tag: 'Unknown'; readonly path: string }

export type GroupReason =
  | { readonly _tag: 'Rerun' }
  | { readonly _tag: 'File'; readonly path: string }
  | { readonly _tag: 'Residue'; readonly path: string }

export type ItemReason =
  | { readonly _tag: 'Rerun' }
  | { readonly _tag: 'Dependency'; readonly path: string }
  | { readonly _tag: 'Group'; readonly reason: GroupReason }
  | { readonly _tag: 'NeededBy'; readonly id: string }

export type Selection =
  | { readonly _tag: 'Full'; readonly cause: FullCause }
  | {
      readonly _tag: 'Only'
      /** Selected item ids in code-unit order. */
      readonly items: readonly string[]
      /** Keys of groups selected as a whole, in code-unit order. */
      readonly groups: readonly string[]
      readonly itemReasons: ReadonlyMap<string, readonly ItemReason[]>
      readonly groupReasons: ReadonlyMap<string, readonly GroupReason[]>
    }

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key)
  if (values === undefined) map.set(key, [value])
  else values.push(value)
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

function firstTrip(
  problem: SelectionProblem,
  itemsByDep: ReadonlyMap<string, readonly SelectionItem[]>,
): FullCause | undefined {
  const known = new Set(problem.known)
  for (const group of problem.groups) {
    if (group.file !== undefined) known.add(group.file)
    for (const path of group.coarse) known.add(path)
  }
  for (const path of problem.changes) {
    const reason = problem.structural.get(path)
    if (reason !== undefined) return { _tag: 'Structural', path, reason }
    if (
      problem.onUnknown === 'full' &&
      !known.has(path) &&
      !itemsByDep.has(path)
    ) {
      return { _tag: 'Unknown', path }
    }
  }
  return undefined
}

function wholeGroupReasons(
  group: SelectionGroup,
  changes: ReadonlySet<string>,
  members: readonly SelectionItem[],
): GroupReason[] {
  const reasons: GroupReason[] = []
  if (group.rerun) reasons.push({ _tag: 'Rerun' })
  if (group.file !== undefined && changes.has(group.file)) {
    reasons.push({ _tag: 'File', path: group.file })
  }
  for (const path of group.coarse) {
    if (!changes.has(path)) continue
    if (!group.exact || !members.some((item) => item.deps.includes(path))) {
      reasons.push({ _tag: 'Residue', path })
    }
  }
  return reasons
}

export function select(problem: SelectionProblem): Selection {
  const itemsByDep = new Map<string, SelectionItem[]>()
  const itemsByGroup = new Map<string, SelectionItem[]>()
  const itemsById = new Map<string, SelectionItem>()
  for (const item of problem.items) {
    for (const dep of new Set(item.deps)) push(itemsByDep, dep, item)
    push(itemsByGroup, item.group, item)
    itemsById.set(item.id, item)
  }

  const cause = firstTrip(problem, itemsByDep)
  if (cause !== undefined) return { _tag: 'Full', cause }

  const changes = new Set(problem.changes)
  const groupReasons = new Map<string, GroupReason[]>()
  for (const group of problem.groups) {
    const reasons = wholeGroupReasons(
      group,
      changes,
      itemsByGroup.get(group.key) ?? [],
    )
    for (const reason of reasons) push(groupReasons, group.key, reason)
  }

  const itemReasons = new Map<string, ItemReason[]>()
  for (const item of problem.items) {
    if (item.rerun) push(itemReasons, item.id, { _tag: 'Rerun' })
    for (const reason of groupReasons.get(item.group) ?? []) {
      push(itemReasons, item.id, { _tag: 'Group', reason })
    }
  }
  for (const path of changes) {
    for (const item of itemsByDep.get(path) ?? []) {
      push(itemReasons, item.id, { _tag: 'Dependency', path })
    }
  }

  const affected = new Set(itemReasons.keys())
  const selected = new Set(affected)
  const pending = [...selected]
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined) continue
    for (const need of itemsById.get(id)?.needs ?? []) {
      if (!affected.has(need)) {
        push(itemReasons, need, { _tag: 'NeededBy', id })
      }
      if (selected.has(need)) continue
      selected.add(need)
      pending.push(need)
    }
  }

  return {
    _tag: 'Only',
    groupReasons,
    groups: sorted(groupReasons.keys()),
    itemReasons,
    items: sorted(selected),
  }
}
