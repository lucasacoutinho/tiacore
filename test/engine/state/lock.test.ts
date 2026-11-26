import * as NodeServices from '@effect/platform-node/NodeServices'
import { hostname } from 'node:os'
import { join } from 'node:path'

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import { expect, layer } from '@effect/vitest'

import { makeLock } from '../../../src/engine/state/lock.ts'
import { tempDirectory } from '../support/layers.ts'

const writeLock = (cacheDir: string, owner: string, ageMs = 0) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = join(cacheDir, 'state.lock')
    yield* fs.makeDirectory(path)
    yield* fs.writeFileString(join(path, 'owner.json'), owner)
    if (ageMs > 0) {
      const time = new Date(Date.now() - ageMs)
      yield* fs.utimes(path, time, time)
    }
  })

const lockEntries = (cacheDir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readDirectory(cacheDir),
  ).pipe(
    Effect.map((entries) =>
      entries.filter((entry) => entry.startsWith('state.lock')),
    ),
  )

/**
 * `fs` whose first recursive removal of a directory holding owner.json runs
 * `between` after emptying it, as a removal that is not atomic allows.
 */
function publishedWhileEmptied(
  fs: FileSystem.FileSystem,
  between: Effect.Effect<void>,
): FileSystem.FileSystem {
  let fired = false
  return {
    ...fs,
    remove: (target, options) =>
      Effect.gen(function* () {
        const owner = join(target, 'owner.json')
        if (
          !fired &&
          options?.recursive === true &&
          !target.includes('.new.') &&
          (yield* fs.exists(owner))
        ) {
          fired = true
          yield* fs.remove(owner)
          yield* between
        }
        return yield* fs.remove(target, options)
      }),
  }
}

layer(NodeServices.layer, { excludeTestServices: true })(
  'commit lock',
  (it) => {
    // POSIX rename replaces an empty directory, so a lock deleted in place can
    // be published over while it is empty and then deleted with its new owner.
    it.effect(
      'a release never deletes a lock another writer published meanwhile',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const cacheDir = yield* tempDirectory('tia-lock-')
          const published = yield* Deferred.make<void>()
          const finish = yield* Deferred.make<void>()
          const competitor =
            yield* Deferred.make<Fiber.Fiber<Option.Option<void>, unknown>>()
          const racing = publishedWhileEmptied(
            fs,
            Effect.forkDetach(
              makeLock(fs).locked(
                cacheDir,
                { lockTimeoutMs: 5_000 },
                Deferred.succeed(published, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                ),
              ),
            ).pipe(
              Effect.tap((fiber) => Deferred.succeed(competitor, fiber)),
              Effect.andThen(Deferred.await(published)),
            ),
          )

          const first = yield* makeLock(racing).locked(
            cacheDir,
            {},
            Effect.succeed('first'),
          )
          // The competitor still holds the lock it published.
          const held = yield* fs.exists(
            join(cacheDir, 'state.lock', 'owner.json'),
          )
          yield* Deferred.succeed(finish, undefined)
          const second = yield* Fiber.join(yield* Deferred.await(competitor))
          const left = yield* lockEntries(cacheDir)
          expect(Option.getOrNull(first)).toBe('first')
          expect(held).toBe(true)
          expect(Option.isSome(second)).toBe(true)
          expect(left).toEqual([])
        }),
    )

    it.effect('releases at once when its cache directory is gone', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = join(yield* tempDirectory('tia-lock-'), 'cache')
        const started = Date.now()
        const result = yield* makeLock(fs).locked(
          cacheDir,
          {},
          fs.remove(cacheDir, { recursive: true }),
        )
        const elapsed = Date.now() - started
        expect(Option.isSome(result)).toBe(true)
        expect(elapsed).toBeLessThan(1_000)
      }),
    )

    it.effect('waits instead of spinning while another reclaimer works', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const cacheDir = yield* tempDirectory('tia-lock-')
        yield* writeLock(
          cacheDir,
          JSON.stringify({
            createdAt: Date.now() - 60_000,
            hostname: 'another-host.invalid',
            pid: 1,
            token: 'stale',
          }),
        )
        // A live reclaimer holds the guard: its age is below the stale limit.
        yield* fs.makeDirectory(join(cacheDir, 'state.lock.reclaim'))
        let drafts = 0
        const counting: FileSystem.FileSystem = {
          ...fs,
          makeDirectory: (path, options) => {
            if (path.includes('.new.')) drafts += 1
            return fs.makeDirectory(path, options)
          },
        }
        const result = yield* makeLock(counting).locked(
          cacheDir,
          { lockTimeoutMs: 300, staleLockMs: 1_000 },
          Effect.void,
        )
        expect(Option.isNone(result)).toBe(true)
        // About one attempt per 20-49 ms back-off, not a hot loop.
        expect(drafts).toBeLessThan(40)
      }),
    )

    it.effect(
      'judges a lock with an impossible pid or creation time by its age',
      () =>
        Effect.gen(function* () {
          for (const owner of [
            // 1e999 parses as Infinity: the lock would never grow old.
            `{"createdAt":1e999,"hostname":"another-host.invalid","pid":1,"token":"x"}`,
            // kill(0) and kill(-1) succeed for a process group, not one process.
            JSON.stringify({
              createdAt: Date.now(),
              hostname: hostname(),
              pid: 0,
              token: 'x',
            }),
            JSON.stringify({
              createdAt: Date.now(),
              hostname: hostname(),
              pid: -1,
              token: 'x',
            }),
          ]) {
            const cacheDir = yield* tempDirectory('tia-lock-')
            yield* writeLock(cacheDir, owner, 60_000)
            const result = yield* makeLock(yield* FileSystem.FileSystem).locked(
              cacheDir,
              { lockTimeoutMs: 1_000, staleLockMs: 10_000 },
              Effect.succeed('held'),
            )
            expect(Option.getOrNull(result)).toBe('held')
            expect(yield* lockEntries(cacheDir)).toEqual([])
          }
        }),
    )
  },
)
