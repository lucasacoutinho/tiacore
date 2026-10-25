// Finds the test that started the async work now running, so coverage that a
// finished test's detached Effect fiber advances during a later test does not
// land in that later test's window (src/probe/ledger.ts `leftover`).
//
// Effect 4 captures an AsyncResource when a fiber yields or is forked and runs
// every later step of the fiber inside `runInAsyncScope`, so an
// AsyncLocalStorage value set around a test body is still current inside the
// fiber after the test ended (test/runners/vitest/leftover.test.ts pins this).
// This module sets that value to the test id and wraps `runInAsyncScope`: a
// step whose owner is not the open window runs as `probe.leftover`.
//
// Nothing here imports a Node built-in. `process.getBuiltinModule` is the
// feature test Effect uses; where it is missing (browser mode, old Node) or
// Effect does not use AsyncResource, nothing is wrapped and a late fiber is
// attributed to the window it ran in, as before.
import type { CoverageProbe } from '../../probe/types.ts'

interface AsyncStore {
  getStore(): unknown
  run<T>(id: string, body: () => T): T
}

type RunInAsyncScope = (
  this: unknown,
  body: (...args: unknown[]) => unknown,
  thisArg?: unknown,
  ...args: unknown[]
) => unknown

interface AsyncHooksModule {
  readonly AsyncLocalStorage?: new () => AsyncStore
  readonly AsyncResource?: {
    readonly prototype: { runInAsyncScope?: RunInAsyncScope }
  }
}

interface Tracker {
  readonly probe: CoverageProbe
  readonly store: AsyncStore
}

export interface LeftoverTracking {
  /** Runs a test's hooks and body so that work it starts knows its owner. */
  run<T>(id: string, body: () => T): T
  /** Stops classifying work for this probe. The wrapper stays and passes through. */
  stop(): void
}

/**
 * The tracker of the newest setup evaluation. It sits on the prototype, which
 * every module and every vm context of the worker shares, because the wrapper
 * outlives the module that installed it.
 */
const TRACKER = Symbol.for('tiacore.vitest.leftover.tracker')
/** The unwrapped `runInAsyncScope`, kept on the prototype to wrap only once. */
const ORIGINAL = Symbol.for('tiacore.vitest.leftover.original')

interface Patched {
  [ORIGINAL]?: RunInAsyncScope
  [TRACKER]?: Tracker
  runInAsyncScope?: RunInAsyncScope
}

function asyncHooks(): AsyncHooksModule | undefined {
  const host = globalThis as {
    process?: { getBuiltinModule?: (id: string) => unknown }
  }
  try {
    const module = host.process?.getBuiltinModule?.('node:async_hooks')
    return typeof module === 'object' && module !== null ? module : undefined
  } catch {
    return undefined
  }
}

function wrap(prototype: Patched, original: RunInAsyncScope): void {
  prototype[ORIGINAL] = original
  prototype.runInAsyncScope = function (body, thisArg, ...args) {
    const tracker = prototype[TRACKER]
    if (tracker === undefined) {
      return original.call(this, body, thisArg, ...args)
    }
    return original.call(this, () => {
      const owner = tracker.store.getStore()
      return typeof owner === 'string'
        ? tracker.probe.leftover(owner, () => body.apply(thisArg, args))
        : body.apply(thisArg, args)
    })
  }
}

export function trackLeftoverWork(
  probe: CoverageProbe,
): LeftoverTracking | undefined {
  const hooks = asyncHooks()
  const Store = hooks?.AsyncLocalStorage
  const prototype: Patched | undefined = hooks?.AsyncResource?.prototype
  if (Store === undefined || prototype === undefined) return undefined
  if (prototype[ORIGINAL] === undefined) {
    const original = prototype.runInAsyncScope
    if (original === undefined) return undefined
    wrap(prototype, original)
  }
  const tracker: Tracker = { probe, store: new Store() }
  prototype[TRACKER] = tracker
  return {
    run: (id, body) => tracker.store.run(id, body),
    stop() {
      if (prototype[TRACKER] === tracker) delete prototype[TRACKER]
    },
  }
}
