import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { normalizedConcurrency } from '../engine/scheduling/parallel.js'

export interface TiaWorkspaceLaneRunner {
  run(): Promise<unknown>
}

export interface TiaWorkspaceLane {
  arguments?: string[]
  command?: string
  cwd?: string
  dependsOn?: string[]
  environment?: NodeJS.ProcessEnv
  id: string
  resourceLocks?: string[]
  runner?: TiaWorkspaceLaneRunner
}

export interface TiaWorkspaceOptions {
  concurrency?: number
  failFast?: boolean
  lanes: TiaWorkspaceLane[]
  root?: string
}

export type TiaWorkspaceLaneStatus = 'blocked' | 'failed' | 'passed'

export interface TiaWorkspaceLaneResult {
  duration: number
  error?: string
  id: string
  result?: unknown
  status: TiaWorkspaceLaneStatus
}

export interface TiaWorkspaceResult {
  lanes: TiaWorkspaceLaneResult[]
  success: boolean
}

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

function resultSuccess(result: unknown): boolean {
  return !(
    result !== null &&
    typeof result === 'object' &&
    'success' in result &&
    (result as { success?: unknown }).success === false
  )
}

async function executeLane(
  lane: TiaWorkspaceLane,
  root: string,
): Promise<unknown> {
  if (lane.runner !== undefined) return await lane.runner.run()

  return await new Promise<{ status: number }>((resolveResult, reject) => {
    const child = spawn(lane.command!, lane.arguments ?? [], {
      cwd: resolve(root, lane.cwd ?? '.'),
      env: { ...process.env, ...lane.environment },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveResult({ status: code ?? (signal === null ? 1 : 128) })
    })
  })
}

export class TiaWorkspaceRunner {
  private readonly options: TiaWorkspaceOptions

  constructor(options: TiaWorkspaceOptions) {
    validateLanes(options.lanes)
    this.options = options
  }

  async run(): Promise<TiaWorkspaceResult> {
    const root = resolve(this.options.root ?? process.cwd())
    const concurrency = normalizedConcurrency(this.options.concurrency)
    const pending = new Map(this.options.lanes.map((lane) => [lane.id, lane]))
    const activeLocks = new Set<string>()
    const running = new Map<string, Promise<void>>()
    const results = new Map<string, TiaWorkspaceLaneResult>()
    let failed = false

    const launch = (lane: TiaWorkspaceLane): void => {
      pending.delete(lane.id)
      for (const lock of lane.resourceLocks ?? []) activeLocks.add(lock)
      const started = performance.now()
      const task = executeLane(lane, root)
        .then((result) => {
          const success =
            resultSuccess(result) &&
            !(
              result !== null &&
              typeof result === 'object' &&
              'status' in result &&
              (result as { status?: unknown }).status !== 0
            )
          failed ||= !success
          results.set(lane.id, {
            duration: performance.now() - started,
            id: lane.id,
            result,
            status: success ? 'passed' : 'failed',
          })
        })
        .catch((error: unknown) => {
          failed = true
          results.set(lane.id, {
            duration: performance.now() - started,
            error: error instanceof Error ? error.message : String(error),
            id: lane.id,
            status: 'failed',
          })
        })
        .finally(() => {
          for (const lock of lane.resourceLocks ?? []) activeLocks.delete(lock)
          running.delete(lane.id)
        })
      running.set(lane.id, task)
    }

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
        if (
          blockedBy !== undefined ||
          (failed && this.options.failFast === true)
        ) {
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
        launch(lane)
        progressed = true
      }

      if (running.size > 0) {
        await Promise.race(running.values())
      } else if (!progressed && pending.size > 0) {
        throw new Error('TIA workspace scheduler could not make progress')
      }
    }

    const lanes = this.options.lanes.map((lane) => results.get(lane.id)!)
    return {
      lanes,
      success: lanes.every((lane) => lane.status === 'passed'),
    }
  }
}

export function tia(options: TiaWorkspaceOptions): TiaWorkspaceRunner {
  return new TiaWorkspaceRunner(options)
}
