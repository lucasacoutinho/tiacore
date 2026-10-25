import type { ProbeCounterMap } from '../../src/probe/types.ts'

// A synthetic Istanbul `__coverage__` and a naive reference for the windows
// proofs/Tia/Window.lean models. The reference copies every counter at every
// boundary, which is what 1.x did and the probe must agree with.

export const SHAPE = { branches: 2, functions: 2, paths: 2, statements: 4 }

export type CounterKind = 'b' | 'f' | 's'

export interface Increment {
  readonly by: number
  readonly file: number
  readonly kind: CounterKind
  readonly path: number
  readonly slot: number
}

interface MutableFile {
  b: Record<string, number[]>
  f: Record<string, number>
  hash: string
  path: string
  s: Record<string, number>
}

export class World {
  readonly coverage: Record<string, MutableFile> = {}

  static pathOf(file: number): string {
    return `/project/src/file${file}.ts`
  }

  /** Registers the file with zeroed counters, as Istanbul does on first load. */
  ensure(file: number): MutableFile {
    const path = World.pathOf(file)
    let entry = this.coverage[path]
    if (entry === undefined) {
      entry = { b: {}, f: {}, hash: `hash${file}`, path, s: {} }
      for (let i = 0; i < SHAPE.statements; i += 1) entry.s[String(i)] = 0
      for (let i = 0; i < SHAPE.functions; i += 1) entry.f[String(i)] = 0
      for (let i = 0; i < SHAPE.branches; i += 1) {
        entry.b[String(i)] = Array.from({ length: SHAPE.paths }, () => 0)
      }
      this.coverage[path] = entry
    }
    return entry
  }

  apply(increment: Increment): void {
    const entry = this.ensure(increment.file)
    if (increment.kind === 's') {
      const key = String(increment.slot % SHAPE.statements)
      entry.s[key] = (entry.s[key] ?? 0) + increment.by
    } else if (increment.kind === 'f') {
      const key = String(increment.slot % SHAPE.functions)
      entry.f[key] = (entry.f[key] ?? 0) + increment.by
    } else {
      const key = String(increment.slot % SHAPE.branches)
      const counts = entry.b[key] ?? []
      const index = increment.path % SHAPE.paths
      counts[index] = (counts[index] ?? 0) + increment.by
    }
  }

  /** Every counter as `path:kind:key[:path]` -> value. */
  dense(): Map<string, number> {
    const counters = new Map<string, number>()
    for (const [path, entry] of Object.entries(this.coverage)) {
      for (const [key, count] of Object.entries(entry.s)) {
        counters.set(`${path}:s:${key}`, count)
      }
      for (const [key, count] of Object.entries(entry.f)) {
        counters.set(`${path}:f:${key}`, count)
      }
      for (const [key, counts] of Object.entries(entry.b)) {
        counts.forEach((count, index) => {
          counters.set(`${path}:b:${key}:${index}`, count)
        })
      }
    }
    return counters
  }
}

export type Dense = Map<string, number>

/** `Cov.delta a b` of the Lean model, clamped at zero like 1.x. */
export function deltaOf(before: Dense, after: Dense): Dense {
  const delta: Dense = new Map()
  for (const [key, count] of after) {
    const advanced = count - (before.get(key) ?? 0)
    if (advanced > 0) delta.set(key, advanced)
  }
  return delta
}

export function addInto(target: Dense, extra: Dense): void {
  for (const [key, count] of extra) {
    target.set(key, (target.get(key) ?? 0) + count)
  }
}

/** Flattens a probe payload to the same `path:kind:key[:path]` form. */
export function denseOf(counters: ProbeCounterMap): Dense {
  const dense: Dense = new Map()
  for (const [path, entry] of Object.entries(counters)) {
    for (const [key, count] of Object.entries(entry.s)) {
      dense.set(`${path}:s:${key}`, count)
    }
    for (const [key, count] of Object.entries(entry.f)) {
      dense.set(`${path}:f:${key}`, count)
    }
    for (const [key, counts] of Object.entries(entry.b)) {
      counts.forEach((count, index) => {
        if (count > 0) dense.set(`${path}:b:${key}:${index}`, count)
      })
    }
  }
  return dense
}

/** The payload shape a dense delta must take: the naive formatter. */
export function formatDelta(
  delta: Dense,
  hashes: ReadonlyMap<string, string>,
): ProbeCounterMap {
  const result: ProbeCounterMap = {}
  for (const [name, count] of delta) {
    const [path = '', kind, key = '', index] = name.split(':')
    const entry = (result[path] ??= {
      b: {},
      f: {},
      hash: hashes.get(path) ?? '',
      s: {},
    })
    if (kind === 's') entry.s[key] = count
    else if (kind === 'f') entry.f[key] = count
    else {
      const counts = (entry.b[key] ??= Array.from(
        { length: SHAPE.paths },
        () => 0,
      ))
      counts[Number(index)] = count
    }
  }
  return result
}

export function sortedFiles(counters: ProbeCounterMap): string[] {
  return Object.keys(counters).sort()
}
