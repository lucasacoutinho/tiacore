import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Random from 'effect/Random'

import type { TiaIo } from '../../wire/errors.ts'
import { ioError } from './state-files.ts'

// The commit lock: the directory <cacheDir>/state.lock holding owner.json.
// A lock is stale when its owner is a dead process on this host, or when it is
// older than the stale threshold. A new lock is published by renaming a
// directory that already holds owner.json, and a stale lock is removed only
// under the reclaim guard after its owner is read again (see reclaim).

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

export const lockPath = (cacheDir: string): string =>
  join(cacheDir, 'state.lock')

function parseOwner(text: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return null
    const owner = value as Partial<LockOwner>
    return typeof owner.createdAt === 'number' &&
      typeof owner.hostname === 'string' &&
      typeof owner.pid === 'number' &&
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

  /**
   * Removes the lock if it still holds the owner judged stale. Reclaimers take
   * a guard directory first, so one at a time re-reads the owner and removes
   * the lock. A new lock cannot appear while the stale one exists, so a
   * confirmed stale owner means the lock removed is the stale one.
   */
  const reclaim = Effect.fnUntraced(function* (
    path: string,
    judged: string | null,
  ) {
    const guard = `${path}.reclaim`
    const guarded = yield* fs.makeDirectory(guard).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (!guarded) {
      // A reclaimer that crashed inside the guard leaves it behind.
      const age = yield* guardAge(guard)
      if (Option.isSome(age) && age.value >= RECLAIM_GUARD_STALE_MS) {
        yield* fs
          .remove(guard, { force: true, recursive: true })
          .pipe(Effect.ignore)
      }
      return
    }
    yield* readOwner(path).pipe(
      Effect.flatMap((owner) =>
        (owner?.token ?? null) === judged
          ? fs.remove(path, { force: true, recursive: true })
          : Effect.void,
      ),
      Effect.ignore,
      Effect.ensuring(
        fs.remove(guard, { force: true, recursive: true }).pipe(Effect.ignore),
      ),
    )
  })

  const guardAge = (guard: string) =>
    Effect.all([fs.stat(guard), Clock.currentTimeMillis]).pipe(
      Effect.map(([info, now]) =>
        Option.map(info.mtime, (time) => now - time.getTime()),
      ),
      Effect.orElseSucceed(() => Option.none<number>()),
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
      if (published) return Option.some(owner)
      const stale = yield* judgeStale(path, staleAfter)
      if (Option.isSome(stale)) {
        yield* reclaim(path, stale.value)
        continue
      }
      yield* Effect.sleep(20 + (yield* Random.nextIntBetween(0, 29)))
    }
  })

  /** Removes the lock only while it still holds this owner's token. */
  const release = (cacheDir: string, owner: LockOwner) =>
    Effect.gen(function* () {
      const path = lockPath(cacheDir)
      const current = yield* readOwner(path)
      if (current?.token === owner.token) {
        yield* fs.remove(path, { force: true, recursive: true })
      }
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
