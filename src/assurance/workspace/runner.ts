import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Predicate from 'effect/Predicate'

import type {
  TiaWorkspaceLane,
  TiaWorkspaceLaneResult,
  TiaWorkspaceOptions,
  TiaWorkspaceResult,
} from '../../core/workspace.ts'
import { runPromise } from '../../host/runtime.ts'
import { TiaFailed, type TiaError } from '../../wire/errors.ts'
import { runProcess } from '../process.ts'
import { decodeWorkspaceOptions } from './options.ts'
import { normalizedConcurrency } from '../../engine/scheduling.ts'

function validateLanes(lanes: readonly TiaWorkspaceLane[]): void {
  const byId = new Map<string, TiaWorkspaceLane>()
  for (const lane of lanes) {
    if (lane.id.trim() === '' || byId.has(lane.id)) {
      throw new Error(`duplicate or empty TIA workspace lane id: ${lane.id}`)
    }
    if ((lane.command === undefined) === (lane.runner === undefined)) {
      throw new Error(
        `TIA workspace lane ${lane.id} must define exactly one command or runner`,
      )
    }
    byId.set(lane.id, lane)
  }
  for (const lane of lanes) {
    for (const dependency of lane.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(
          `TIA workspace lane ${lane.id} depends on unknown lane ${dependency}`,
        )
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`TIA workspace lane dependency cycle includes ${id}`)
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const lane of lanes) visit(lane.id)
}

/** A lane fails when its result says `success: false` or `status` is not 0. */
function laneSucceeded(result: unknown): boolean {
  if (!Predicate.isObject(result)) return true
  if ('success' in result && result.success === false) return false
  return !('status' in result && result.status !== 0)
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const executeLane = Effect.fnUntraced(function* (
  lane: TiaWorkspaceLane,
  root: string,
) {
  const { runner } = lane
  if (runner !== undefined) {
    return yield* Effect.tryPromise({
      catch: (error) => new TiaFailed({ message: errorMessage(error) }),
      try: () => runner.run(),
    })
  }
  const outcome = yield* runProcess({
    args: lane.arguments ?? [],
    command: lane.command ?? '',
    cwd: resolve(root, lane.cwd ?? '.'),
    env: lane.environment,
    stdio: 'inherit',
  })
  return { status: outcome.code ?? 128 }
})

const schedule = Effect.fnUntraced(function* (options: TiaWorkspaceOptions) {
  const root = resolve(options.root ?? process.cwd())
  const concurrency = normalizedConcurrency(options.concurrency)
  const pending = new Map(options.lanes.map((lane) => [lane.id, lane]))
  const activeLocks = new Set<string>()
  const running = new Map<string, Fiber.Fiber<void>>()
  const results = new Map<string, TiaWorkspaceLaneResult>()
  let failed = false

  const settle =
    (lane: TiaWorkspaceLane, started: number) =>
    (outcome: {
      readonly error?: TiaError
      readonly ok: boolean
      readonly result?: unknown
    }) =>
      Effect.sync(() => {
        const duration = performance.now() - started
        if (!outcome.ok) {
          failed = true
          results.set(lane.id, {
            duration,
            error: outcome.error?.message ?? '',
            id: lane.id,
            status: 'failed',
          })
          return
        }
        const success = laneSucceeded(outcome.result)
        failed ||= !success
        results.set(lane.id, {
          duration,
          id: lane.id,
          result: outcome.result,
          status: success ? 'passed' : 'failed',
        })
      })

  const launch = Effect.fnUntraced(function* (lane: TiaWorkspaceLane) {
    pending.delete(lane.id)
    for (const lock of lane.resourceLocks ?? []) activeLocks.add(lock)
    const started = performance.now()
    const record = settle(lane, started)
    const task = executeLane(lane, root).pipe(
      Effect.matchEffect({
        onFailure: (error) => record({ error, ok: false }),
        onSuccess: (result) => record({ ok: true, result }),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          for (const lock of lane.resourceLocks ?? []) activeLocks.delete(lock)
          running.delete(lane.id)
        }),
      ),
    )
    running.set(lane.id, yield* Effect.forkChild(task))
  })

  while (pending.size > 0 || running.size > 0) {
    let progressed = false
    for (const lane of pending.values()) {
      const dependencies = lane.dependsOn ?? []
      const blockedBy = dependencies.find(
        (id) => results.get(id)?.status !== 'passed',
      )
      const waiting = dependencies.some(
        (id) => !results.has(id) && (pending.has(id) || running.has(id)),
      )
      if (waiting) continue
      if (blockedBy !== undefined || (failed && options.failFast === true)) {
        pending.delete(lane.id)
        results.set(lane.id, {
          duration: 0,
          error:
            blockedBy === undefined
              ? 'workspace stopped after an earlier lane failed'
              : `dependency ${blockedBy} did not pass`,
          id: lane.id,
          status: 'blocked',
        })
        progressed = true
        continue
      }
      if (running.size >= concurrency) continue
      if ((lane.resourceLocks ?? []).some((lock) => activeLocks.has(lock))) {
        continue
      }
      yield* launch(lane)
      progressed = true
    }

    if (running.size > 0) {
      yield* Effect.raceAll(
        [...running.values()].map((fiber) => Fiber.await(fiber)),
      )
    } else if (!progressed && pending.size > 0) {
      return yield* new TiaFailed({
        message: 'TIA workspace scheduler could not make progress',
      })
    }
  }

  const lanes = options.lanes.map((lane) => results.get(lane.id)!)
  const result: TiaWorkspaceResult = {
    lanes,
    success: lanes.every((lane) => lane.status === 'passed'),
  }
  return result
})

export class TiaWorkspaceRunner {
  private readonly options: TiaWorkspaceOptions

  constructor(options: TiaWorkspaceOptions) {
    this.options = decodeWorkspaceOptions(options)
    validateLanes(this.options.lanes)
  }

  run(): Promise<TiaWorkspaceResult> {
    return runPromise(schedule(this.options))
  }
}

export function tia(options: TiaWorkspaceOptions): TiaWorkspaceRunner {
  return new TiaWorkspaceRunner(options)
}
