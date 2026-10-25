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
// older than the stale threshold. A stale lock is reclaimed by renaming it
// away (atomic, so one waiter wins) and checking that what was moved is the
// lock that was judged stale; a live lock moved by mistake is put back.

export interface LockOwner {
  readonly createdAt: number
  readonly hostname: string
  readonly pid: number
  readonly token: string
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000
export const DEFAULT_STALE_LOCK_MS = 120_000

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

  const reclaim = Effect.fnUntraced(function* (
    path: string,
    judged: string | null,
  ) {
    const moved = `${path}.stale.${process.pid}.${randomUUID()}`
    const renamed = yield* fs.rename(path, moved).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (!renamed) return
    const owner = yield* readOwner(moved)
    if ((owner?.token ?? null) !== judged) {
      const restored = yield* fs.rename(moved, path).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (restored) return
    }
    yield* fs
      .remove(moved, { force: true, recursive: true })
      .pipe(Effect.ignore)
  })

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
      const held = yield* fs.makeDirectory(path).pipe(
        Effect.as(false),
        Effect.catch((error) =>
          error.reason._tag === 'AlreadyExists'
            ? Effect.succeed(true)
            : Effect.fail(ioError(error)),
        ),
      )
      if (!held) {
        yield* fs
          .writeFileString(
            join(path, 'owner.json'),
            `${JSON.stringify(owner)}\n`,
          )
          .pipe(
            Effect.onError(() =>
              fs
                .remove(path, { force: true, recursive: true })
                .pipe(Effect.ignore),
            ),
            Effect.mapError(ioError),
          )
        return Option.some(owner)
      }
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
        )
        if (Option.isNone(owner)) return Option.none<A>()
        return Option.some(yield* body)
      }),
    )

  return { locked }
}
