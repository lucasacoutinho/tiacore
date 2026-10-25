// Implements proofs/Tia/Window.lean. `sync` is `Cov.delta boundary snap` followed
// by `boundary := snap`; it charges the delta to the test window that is open,
// or to collection when none is, so `conservation` holds for sequential traces:
// collection plus the sum of the test deltas equals the whole delta.
//
// 1.x copied every counter of every file into fresh objects several times for
// each window, about 4.7 ms a copy on 300 files x 560 counters. The ledger keeps one
// Float64Array of boundary counters per file and does one pass per boundary
// that reads, compares and advances the boundary together. A file whose
// counters did not move allocates nothing, and a window's accumulators exist
// only for the files the window touched.

import type {
  CoverageProbe,
  ProbeCounterMap,
  ProbeCounters,
  ProbeCoverageFile,
  ProbeCoverageMap,
  ProbeCoverageSource,
  ProbeModuleWindow,
  ProbeTestWindow,
} from './types.ts'

/** Istanbul numbers its counters, so integer keys index its objects directly. */
type CounterKey = number | string

interface BranchSlot {
  readonly index: CounterKey
  readonly length: number
  readonly name: string
  readonly offset: number
}

/** One instrumented file: live references plus the counters at the boundary. */
interface FileLedger {
  readonly b: readonly BranchSlot[]
  readonly base: Float64Array
  readonly bObject: Readonly<Record<string, readonly number[]>> | undefined
  readonly fIndex: readonly CounterKey[]
  readonly fNames: readonly string[]
  readonly fObject: Readonly<Record<string, number>> | undefined
  readonly file: ProbeCoverageFile
  readonly hash: string
  readonly path: string
  readonly sIndex: readonly CounterKey[]
  readonly sNames: readonly string[]
  readonly sObject: Readonly<Record<string, number>> | undefined
  readonly scratch: Float64Array
  /** Flat length: statements, then functions, then every branch path. */
  readonly size: number
  seen: number
}

/** Counters a window advanced, per file, in the file's flat layout. */
type Accumulator = Map<FileLedger, Float64Array>

function counterKey(name: string): CounterKey {
  const number = Number(name)
  return Number.isInteger(number) && number >= 0 && String(number) === name
    ? number
    : name
}

function openLedger(file: ProbeCoverageFile, key: string, seen: number) {
  const sNames = Object.keys(file.s ?? {})
  const fNames = Object.keys(file.f ?? {})
  const branches: BranchSlot[] = []
  let size = sNames.length + fNames.length
  for (const [name, counts] of Object.entries(file.b ?? {})) {
    branches.push({
      index: counterKey(name),
      length: counts.length,
      name,
      offset: size,
    })
    size += counts.length
  }
  const ledger: FileLedger = {
    b: branches,
    base: new Float64Array(size),
    bObject: file.b,
    fIndex: fNames.map(counterKey),
    fNames,
    fObject: file.f,
    file,
    hash: file.hash ?? '',
    path: file.path ?? key,
    sIndex: sNames.map(counterKey),
    sNames,
    sObject: file.s,
    scratch: new Float64Array(size),
    seen,
    size,
  }
  return ledger
}

/**
 * Reads the file's counters once. Returns the per-counter advance in the
 * ledger's scratch array, or null when no counter advanced. The boundary moves
 * to what was read; a counter that went down (a reset) moves the boundary down
 * without charging anything.
 */
function advance(ledger: FileLedger): Float64Array | null {
  const { base, scratch } = ledger
  let advanced = false
  let touched = false
  let at = 0

  const statements = ledger.sObject
  if (statements !== undefined) {
    const index = ledger.sIndex
    for (let i = 0; i < index.length; i += 1, at += 1) {
      const value = statements[index[i] as CounterKey] ?? 0
      const before = base[at] as number
      if (value === before) continue
      if (!touched) scratch.fill(0)
      touched = true
      base[at] = value
      if (value > before) {
        scratch[at] = value - before
        advanced = true
      }
    }
  }

  const functions = ledger.fObject
  if (functions !== undefined) {
    const index = ledger.fIndex
    for (let i = 0; i < index.length; i += 1, at += 1) {
      const value = functions[index[i] as CounterKey] ?? 0
      const before = base[at] as number
      if (value === before) continue
      if (!touched) scratch.fill(0)
      touched = true
      base[at] = value
      if (value > before) {
        scratch[at] = value - before
        advanced = true
      }
    }
  }

  const branches = ledger.bObject
  if (branches !== undefined) {
    for (const slot of ledger.b) {
      const counts = branches[slot.index]
      if (counts === undefined) continue
      for (let i = 0; i < slot.length; i += 1) {
        const value = counts[i] ?? 0
        const position = slot.offset + i
        const before = base[position] as number
        if (value === before) continue
        if (!touched) scratch.fill(0)
        touched = true
        base[position] = value
        if (value > before) {
          scratch[position] = value - before
          advanced = true
        }
      }
    }
  }

  return advanced ? scratch : null
}

function charge(
  target: Accumulator,
  ledger: FileLedger,
  advanced: Float64Array,
): void {
  const total = target.get(ledger)
  if (total === undefined) {
    target.set(ledger, advanced.slice())
    return
  }
  for (let i = 0; i < total.length; i += 1) {
    total[i] = (total[i] as number) + (advanced[i] as number)
  }
}

function counters(ledger: FileLedger, total: Float64Array): ProbeCounters {
  const s: Record<string, number> = {}
  const f: Record<string, number> = {}
  const b: Record<string, number[]> = {}
  let at = 0
  for (const name of ledger.sNames) {
    const count = total[at] as number
    if (count > 0) s[name] = count
    at += 1
  }
  for (const name of ledger.fNames) {
    const count = total[at] as number
    if (count > 0) f[name] = count
    at += 1
  }
  for (const slot of ledger.b) {
    let any = false
    for (let i = 0; i < slot.length; i += 1) {
      if ((total[slot.offset + i] as number) > 0) {
        any = true
        break
      }
    }
    if (any) {
      b[slot.name] = Array.from(
        total.subarray(slot.offset, slot.offset + slot.length),
      )
    }
  }
  return { b, f, hash: ledger.hash, s }
}

function render(target: Accumulator): ProbeTestWindow {
  const coverage: ProbeCounterMap = {}
  for (const [ledger, total] of target) {
    coverage[ledger.path] = counters(ledger, total)
  }
  return { coverage, files: Object.keys(coverage).sort() }
}

class Ledger implements CoverageProbe {
  private readonly source: ProbeCoverageSource
  private readonly ledgers = new Map<string, FileLedger>()
  private readonly open = new Map<string, Accumulator>()
  private collection: Accumulator = new Map()
  private whole: Accumulator = new Map()
  private concurrent = false
  private epoch = 0

  constructor(source: ProbeCoverageSource) {
    this.source = source
    this.sync(false)
  }

  beginTest(id: string, concurrent = false): void {
    this.concurrent ||= concurrent || this.open.size > 0
    this.sync(true)
    this.open.set(id, new Map())
  }

  endTest(id: string): ProbeTestWindow {
    const window = this.open.get(id)
    if (window === undefined) return { coverage: {}, files: [] }
    this.sync(true)
    this.open.delete(id)
    return render(window)
  }

  gap(): void {
    this.sync(true)
  }

  closeModule(): ProbeModuleWindow {
    this.sync(true)
    const concurrent = this.concurrent
    const whole = render(this.whole)
    const collection = concurrent ? whole : render(this.collection)
    this.collection = new Map()
    this.whole = new Map()
    this.open.clear()
    this.concurrent = false
    return {
      collectionCoverage: collection.coverage,
      collectionFiles: collection.files,
      concurrent,
      files: whole.files,
    }
  }

  private liveCoverage(): ProbeCoverageMap | undefined {
    return typeof this.source === 'function' ? this.source() : this.source
  }

  /**
   * Moves the boundary to the live counters and charges the advance to every
   * open test window, or to collection when none is open.
   */
  private sync(chargeAdvance: boolean): void {
    const live = this.liveCoverage()
    this.epoch += 1
    const epoch = this.epoch
    const ledgers = this.ledgers

    if (live !== undefined) {
      for (const key in live) {
        const file = live[key]
        if (file === undefined) continue
        let ledger = ledgers.get(key)
        if (ledger === undefined || ledger.file !== file) {
          ledger = openLedger(file, key, epoch)
          ledgers.set(key, ledger)
        }
        ledger.seen = epoch
        const advanced = advance(ledger)
        if (advanced !== null && chargeAdvance)
          this.chargeAdvance(ledger, advanced)
      }
    }

    if (ledgers.size > 0) {
      for (const [key, ledger] of ledgers) {
        if (ledger.seen !== epoch) ledgers.delete(key)
      }
    }
  }

  private chargeAdvance(ledger: FileLedger, advanced: Float64Array): void {
    charge(this.whole, ledger, advanced)
    if (this.open.size === 0) {
      charge(this.collection, ledger, advanced)
      return
    }
    for (const window of this.open.values()) charge(window, ledger, advanced)
  }
}

/**
 * Starts a ledger at the counters that exist now. Everything those counters
 * already hold belongs to no window.
 */
export function installProbe(source: ProbeCoverageSource): CoverageProbe {
  return new Ledger(source)
}
