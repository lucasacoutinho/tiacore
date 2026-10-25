import { spawnSync } from 'node:child_process'

import { exactMedian } from './stats.ts'

// Small helpers the bench workloads share: ordering, timing and spawning.

/**
 * `items` rotated by `round`, so every contender starts first equally often
 * and a load spike does not always hit the same one. With two items the order
 * alternates.
 */
export function interleave<T>(items: readonly T[], round: number): T[] {
  const start = round % items.length
  return [...items.slice(start), ...items.slice(0, start)]
}

export type Version = 'current' | 'legacy'

export interface Both<T> {
  readonly current: T
  readonly legacy: T
}

const VERSIONS: readonly Version[] = ['current', 'legacy']

/**
 * Runs `run` for 2.0 (`current`) and for 1.x (`legacy`), the order alternating
 * with `round`, and returns what each produced.
 */
export function bothVersions<T>(
  round: number,
  run: (version: Version) => T,
): Both<T> {
  const results = new Map<Version, T>()
  for (const version of interleave(VERSIONS, round)) {
    results.set(version, run(version))
  }
  const current = results.get('current')
  const legacy = results.get('legacy')
  if (current === undefined || legacy === undefined) {
    throw new Error('a version produced nothing')
  }
  return { current, legacy }
}

/** `bothVersions` for a body that needs to await. */
export async function bothVersionsAsync<T>(
  round: number,
  run: (version: Version) => Promise<T>,
): Promise<Both<T>> {
  const results = new Map<Version, T>()
  for (const version of interleave(VERSIONS, round)) {
    results.set(version, await run(version))
  }
  const current = results.get('current')
  const legacy = results.get('legacy')
  if (current === undefined || legacy === undefined) {
    throw new Error('a version produced nothing')
  }
  return { current, legacy }
}

/** Milliseconds `body` takes, and what it returned. */
export function timed<T>(body: () => T): { ms: number; value: T } {
  const started = performance.now()
  const value = body()
  return { ms: performance.now() - started, value }
}

/** Milliseconds `body` takes, and what it resolved to. */
export async function timedAsync<T>(
  body: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const started = performance.now()
  const value = await body()
  return { ms: performance.now() - started, value }
}

/** The median of `reps` timings: one stalled run does not decide a round. */
export function medianOf(reps: number, body: () => number): number {
  return exactMedian(Array.from({ length: reps }, body))
}

export interface Spawned {
  readonly ms: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Wall time of one child process, as the caller waits for it. A failed child
 * stops the benchmark: a number measured on an error is not a measurement.
 */
export function spawnTimed(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Spawned {
  const started = performance.now()
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const ms = performance.now() - started
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status ?? result.signal}\n${result.stdout}${result.stderr}`,
    )
  }
  return { ms, stderr: result.stderr, stdout: result.stdout }
}
