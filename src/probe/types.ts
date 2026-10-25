// The worker-side coverage ledger's public shapes. Plain TypeScript: the probe
// runs inside Vitest workers and browser mode, so it imports no Effect and no
// Node built-ins.

/** One instrumented file as Istanbul keeps it in `__coverage__`. */
export interface ProbeCoverageFile {
  readonly b?: Readonly<Record<string, readonly number[]>>
  readonly f?: Readonly<Record<string, number>>
  /** Istanbul's instrumentation hash; it identifies the file's static maps. */
  readonly hash?: string
  readonly path?: string
  readonly s?: Readonly<Record<string, number>>
}

export type ProbeCoverageMap = Readonly<Record<string, ProbeCoverageFile>>

/**
 * Where the probe reads live counters. A function is read on every boundary,
 * so a replaced or deleted `globalThis.__coverage__` is followed.
 */
export type ProbeCoverageSource =
  | ProbeCoverageMap
  | (() => ProbeCoverageMap | undefined)

/**
 * Counters one file advanced in a window. Only advanced statement and function
 * counters appear; a branch appears with all of its paths when any advanced.
 * The static maps never travel: `hash` names them on the main side.
 */
export interface ProbeCounters {
  b: Record<string, number[]>
  f: Record<string, number>
  hash: string
  s: Record<string, number>
}

/** Istanbul file paths mapped to the counters they advanced. */
export type ProbeCounterMap = Record<string, ProbeCounters>

export interface ProbeTestWindow {
  coverage: ProbeCounterMap
  /** Sorted paths whose counters advanced in the window. */
  files: string[]
}

export interface ProbeModuleWindow {
  /**
   * Counters advanced outside test bodies, and by work a finished test left
   * running (`CoverageProbe.leftover`). A module that ran tests concurrently
   * cannot split them, so it reports every counter the module advanced.
   */
  collectionCoverage: ProbeCounterMap
  collectionFiles: string[]
  concurrent: boolean
  /** Sorted paths advanced anywhere in the module. */
  files: string[]
}

export interface CoverageProbe {
  /**
   * Charges everything since the last boundary to collection, then opens a
   * test window. Pass `concurrent` when the runner may overlap this test with
   * others; the module then reports a conservative collection window.
   */
  beginTest(id: string, concurrent?: boolean): void
  /** Closes a test window and returns the counters it advanced. */
  endTest(id: string): ProbeTestWindow
  /** Charges everything since the last boundary to collection. */
  gap(): void
  /**
   * Runs `body`, a synchronous step of work the test `owner` started and left
   * running, such as a detached fiber. Another test's window may be open while
   * it runs, but the open test did not cause it. The counters `body` advances
   * go to collection, which every test of the module shares, and not to the
   * open windows. Outside any window, or inside the owner's own window, `body`
   * is charged as usual.
   */
  leftover<T>(owner: string, body: () => T): T
  /** Takes the final gap, returns the module's windows and starts afresh. */
  closeModule(): ProbeModuleWindow
}
