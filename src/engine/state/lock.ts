import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Random from 'effect/Random'

import { ioError, type TiaIo } from '../../wire/errors.ts'

// The commit lock: the directory <cacheDir>/state.lock holding owner.json.
// A lock is stale when its owner is a dead process on this host, or when it is
// older than the stale threshold. A new lock is published by renaming a
// directory that already holds owner.json. A lock is removed, on release or as
// stale, only under the reclaim guard after its owner is read again, and by
// renaming it aside before deleting it: POSIX rename replaces an empty
// directory, so a lock emptied in place could be published over and then
// deleted with the new owner inside.

export interface LockOwner {
  readonly createdAt: number
  readonly hostname: string
  readonly pid: number
  readonly token: string
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
export const DEFAULT_STALE_LOCK_MS = 120_000
/** A reclaim guard older than this was left by a reclaimer that crashed. */
const RECLAIM_GUARD_STALE_MS = 5_000
/** How long a release waits for the reclaim guard before removing unguarded. */
const RELEASE_GUARD_WAIT_MS = 2 * RECLAIM_GUARD_STALE_MS

export const lockPath = (cacheDir: string): string =>
  join(cacheDir, 'state.lock')

function parseOwner(text: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return null
    const owner = value as Partial<LockOwner>
    // A pid of 0 or below names a process group to kill(2), and a createdAt of
    // 1e999 parses as Infinity and would keep the lock young forever; such an
    // owner is unreadable and the lock is judged by its directory's age.
    return Number.isFinite(owner.createdAt) &&
      typeof owner.hostname === 'string' &&
      Number.isSafeInteger(owner.pid) &&
      (owner.pid ?? 0) > 0 &&
      typeof owner.token === 'string'
      ? (owner as LockOwner)
      : null
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EPERM'
    )
  }
}

export function makeLock(fs: FileSystem.FileSystem) {
  const readOwner = (path: string) =>
    fs.readFileString(join(path, 'owner.json')).pipe(
      Effect.map(parseOwner),
      Effect.orElseSucceed(() => null),
    )

  /** The token of a stale lock (null for an unreadable owner), or none. */
  const judgeStale = Effect.fnUntraced(function* (
    path: string,
    staleAfter: number,
  ) {
    const owner = yield* readOwner(path)
    const created = owner?.createdAt
    const now = yield* Clock.currentTimeMillis
    const modified =
      created !== undefined
        ? Option.some(created)
        : yield* fs.stat(path).pipe(
            Effect.map((info) =>
              Option.map(info.mtime, (time) => time.getTime()),
            ),
            Effect.orElseSucceed(() => Option.none<number>()),
          )
    if (Option.isNone(modified)) return Option.none<string | null>()
    const deadLocal =
      owner !== null &&
      owner.hostname === hostname() &&
      !processAlive(owner.pid)
    return deadLocal || now - modified.value >= staleAfter
      ? Option.some(owner?.token ?? null)
      : Option.none<string | null>()
  })

  const guardAge = (guard: string) =>
    Effect.all([fs.stat(guard), Clock.currentTimeMillis]).pipe(
      Effect.map(([info, now]) =>
        Option.map(info.mtime, (time) => now - time.getTime()),
      ),
      Effect.orElseSucceed(() => Option.none<number>()),
    )

  const dropGuard = (guard: string) =>
    fs.remove(guard, { force: true, recursive: true }).pipe(Effect.ignore)

  /**
   * Takes the reclaim guard: true when taken, false while another holds it,
   * null when it cannot be made (the cache directory is gone, say). A guard a
   * crashed reclaimer left behind is cleared.
   */
  const tryGuard = Effect.fnUntraced(function* (guard: string) {
    const taken = yield* fs.makeDirectory(guard).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (taken) return true
    const age = yield* guardAge(guard)
    if (Option.isNone(age)) return null
    if (age.value >= RECLAIM_GUARD_STALE_MS) yield* dropGuard(guard)
    return false
  })

  /** Moves the lock aside in one rename, then deletes it there. */
  const discard = (path: string) => {
    const trash = `${path}.releasing.${randomUUID()}`
    return fs
      .rename(path, trash)
      .pipe(
        Effect.andThen(fs.remove(trash, { force: true, recursive: true })),
        Effect.ignore,
      )
  }

  /** Discards the lock if it still holds `token` (null: an unreadable owner). */
  const discardIfOwned = (path: string, token: string | null) =>
    readOwner(path).pipe(
      Effect.flatMap((owner) =>
        (owner?.token ?? null) === token ? discard(path) : Effect.void,
      ),
    )

  /**
   * Removes the lock if it still holds the owner judged stale; false when
   * another reclaimer holds the guard. Reclaimers take a guard directory
   * first, so one at a time re-reads the owner and removes the lock. A new
   * lock cannot appear while the stale one exists, so a confirmed stale owner
   * means the lock removed is the stale one.
   */
  const reclaim = Effect.fnUntraced(function* (
    path: string,
    judged: string | null,
  ) {
    const guard = `${path}.reclaim`
    if ((yield* tryGuard(guard)) !== true) return false
    yield* discardIfOwned(path, judged).pipe(Effect.ensuring(dropGuard(guard)))
    return true
  })

  /**
   * Deletes locks a crashed release renamed aside but never deleted. A
   * `.releasing.` directory is never a live lock, so any holder may sweep.
   */
  const sweepDiscarded = (path: string) => {
    const prefix = `${basename(path)}.releasing.`
    return fs.readDirectory(dirname(path)).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries.filter((entry) => entry.startsWith(prefix)),
          (entry) =>
            fs.remove(join(dirname(path), entry), {
              force: true,
              recursive: true,
            }),
          { discard: true },
        ),
      ),
      Effect.ignore,
    )
  }

  const backOff = Effect.flatMap(Random.nextIntBetween(0, 29), (jitter) =>
    Effect.sleep(20 + jitter),
  )

  /** Takes the lock, or returns none once `timeout` milliseconds have passed. */
  const acquire = Effect.fnUntraced(function* (
    cacheDir: string,
    timeout: number,
    staleAfter: number,
  ) {
    const path = lockPath(cacheDir)
    const started = yield* Clock.currentTimeMillis
    yield* fs
      .makeDirectory(cacheDir, { recursive: true })
      .pipe(Effect.mapError(ioError))
    for (;;) {
      const now = yield* Clock.currentTimeMillis
      if (now - started >= timeout) return Option.none<LockOwner>()
      const owner: LockOwner = {
        createdAt: now,
        hostname: hostname(),
        pid: process.pid,
        token: randomUUID(),
      }
      // The owner is written before the lock appears: a lock directory never
      // exists without owner.json, so a waiter reclaiming a stale lock cannot
      // move a new lock away before its owner is known.
      // Publishing is uninterruptible, so an interrupt cannot land between a
      // successful rename and the caller registering the release.
      const draft = `${path}.new.${owner.token}`
      const published = yield* fs.makeDirectory(draft).pipe(
        Effect.andThen(
          fs.writeFileString(
            join(draft, 'owner.json'),
            `${JSON.stringify(owner)}\n`,
          ),
        ),
        Effect.mapError(ioError),
        // The rename fails while another writer holds the lock; the loop
        // then waits or reclaims and tries again.
        Effect.andThen(
          fs.rename(draft, path).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        ),
        Effect.ensuring(
          fs
            .remove(draft, { force: true, recursive: true })
            .pipe(Effect.ignore),
        ),
        Effect.uninterruptible,
      )
      if (published) {
        yield* sweepDiscarded(path)
        return Option.some(owner)
      }
      const stale = yield* judgeStale(path, staleAfter)
      // Retry at once after a reclaim; wait while another reclaimer works.
      if (Option.isSome(stale) && (yield* reclaim(path, stale.value))) continue
      yield* backOff
    }
  })

  /**
   * Removes the lock only while it still holds this owner's token. The check
   * and the removal run under the reclaim guard, so a reclaimer cannot swap
   * the lock between them; a guard still busy after `RELEASE_GUARD_WAIT_MS`,
   * or one that cannot be made, is not waited for.
   */
  const release = (cacheDir: string, owner: LockOwner) =>
    Effect.gen(function* () {
      const path = lockPath(cacheDir)
      const guard = `${path}.reclaim`
      const deadline = (yield* Clock.currentTimeMillis) + RELEASE_GUARD_WAIT_MS
      let guarded = yield* tryGuard(guard)
      while (guarded === false && (yield* Clock.currentTimeMillis) < deadline) {
        yield* backOff
        guarded = yield* tryGuard(guard)
      }
      yield* discardIfOwned(path, owner.token).pipe(
        Effect.ensuring(guarded === true ? dropGuard(guard) : Effect.void),
      )
    }).pipe(Effect.ignore)

  /**
   * Runs `body` holding the lock. The lock is released when the body ends,
   * fails or is interrupted. None when the lock could not be taken in time.
   * Waiting for the lock can be interrupted.
   */
  const locked = <A, E, R>(
    cacheDir: string,
    options: { readonly lockTimeoutMs?: number; readonly staleLockMs?: number },
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<Option.Option<A>, E | TiaIo, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Effect.acquireRelease(
          acquire(
            cacheDir,
            options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
            options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
          ),
          (acquired) =>
            Option.isSome(acquired)
              ? release(cacheDir, acquired.value)
              : Effect.void,
          { interruptible: true },
        )
        if (Option.isNone(owner)) return Option.none<A>()
        return Option.some(yield* body)
      }),
    )

  return { locked }
}
