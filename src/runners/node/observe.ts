import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import type { CachedTestResult } from '../../core/runtime.ts'
import type { TiaObservation } from '../../engine/core.ts'
import { slash } from '../../engine/host-path.ts'
import type { HostServices } from '../../host/runtime.ts'
import { groupBy } from '../shared/concurrency.ts'
import { isObject } from '../shared/json.ts'
import {
  moduleFailureObservation,
  observationOf,
} from '../shared/observations.ts'
import { childEnvironment, runChild } from '../shared/process.ts'
import type { FileObservations } from '../shared/run.ts'
import {
  nodeDiscoveryHooksSupported,
  parseNodeDiscoveryRecords,
  type NodeCase,
  type NodeDiscovery,
  type NodeExecution,
} from './discovery.ts'

/** An execution child that outlives this is killed and counted as a crash. */
const EXECUTION_TIMEOUT_MS = 30_000

export interface NodeHelpers {
  readonly execution: string
  readonly register: string
}

export interface NodeContext {
  readonly concurrency: number
  readonly helpers: NodeHelpers
  readonly log: boolean
  readonly root: string
  /** Execution child time limit; defaults to 30 seconds. */
  readonly timeoutMs?: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNodeCase(value: unknown): value is NodeCase {
  return (
    isObject(value) &&
    typeof value['file'] === 'string' &&
    typeof value['fullName'] === 'string' &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['line'] === 'number' &&
    typeof value['column'] === 'number' &&
    (value['state'] === 'failed' ||
      value['state'] === 'passed' ||
      value['state'] === 'skipped')
  )
}

/** The child's result file, or null when it is not a complete result. */
export function parseNodeExecution(source: string): NodeExecution | null {
  const value: unknown = JSON.parse(source)
  if (!isObject(value)) return null
  const { cases, coverageFiles, moduleFailures, success } = value
  if (
    !Array.isArray(cases) ||
    !cases.every(isNodeCase) ||
    !stringArray(coverageFiles) ||
    !stringArray(moduleFailures) ||
    typeof success !== 'boolean'
  ) {
    return null
  }
  return { cases, coverageFiles, moduleFailures, success }
}

function failedExecution(
  context: NodeContext,
  files: readonly string[],
): NodeExecution {
  return {
    cases: [],
    coverageFiles: [],
    moduleFailures: files.map((file) => slash(relative(context.root, file))),
    success: false,
  }
}

/**
 * Runs node:test over `files` in one child with V8 and native coverage. Any
 * failure to produce a valid result (spawn error, crash, the timeout) is a
 * synthetic execution that fails every requested file.
 */
export const executeNode = (
  context: NodeContext,
  files: readonly string[],
  pattern: RegExp | undefined,
): Effect.Effect<NodeExecution, never, HostServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: 'tiacore-node-execution-',
      })
      const coverageDirectory = join(temporary, 'v8-coverage')
      const request = join(temporary, 'request.json')
      const output = join(temporary, 'result.json')
      yield* fs.writeFileString(
        request,
        JSON.stringify({
          coverage: true,
          coverageDirectory,
          files,
          ...(pattern === undefined
            ? {}
            : { pattern: { flags: pattern.flags, source: pattern.source } }),
          root: context.root,
        }),
      )
      yield* runChild({
        args: [context.helpers.execution, request, output],
        command: process.execPath,
        cwd: context.root,
        env: childEnvironment({
          NODE_V8_COVERAGE: coverageDirectory,
          ...(context.log ? { TIACORE_NODE_DEBUG: '1' } : {}),
        }),
        stdio: context.log ? 'inherit' : 'ignore',
        timeoutMs: context.timeoutMs ?? EXECUTION_TIMEOUT_MS,
      })
      const execution = parseNodeExecution(yield* fs.readFileString(output))
      return execution ?? failedExecution(context, files)
    }),
  ).pipe(Effect.orElseSucceed(() => failedExecution(context, files)))

/** The relative file when its discovery child failed, null when it is clean. */
const discoverFile = Effect.fnUntraced(function* (
  context: NodeContext,
  file: string,
  output: string,
) {
  const outcome = yield* runChild({
    args: ['--import', pathToFileURL(context.helpers.register).href, file],
    command: process.execPath,
    cwd: context.root,
    env: childEnvironment({ TIACORE_NODE_DISCOVERY_FILE: output }),
    stdio: context.log ? 'inherit' : 'ignore',
  })
  return outcome.code === 0 ? null : slash(relative(context.root, file))
})

/**
 * Precise discovery: one child per file loads it with `node:test` replaced by
 * a recording shim. Null when it found nothing at all (no cases, no failures),
 * which sends the caller to the aggregate path.
 */
const discoverWithHooks = (
  context: NodeContext,
  files: readonly string[],
): Effect.Effect<NodeDiscovery | null, never, HostServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: 'tiacore-node-discovery-',
      })
      const output = join(temporary, 'cases.jsonl')
      yield* fs.writeFileString(output, '')
      const failed = yield* Effect.forEach(
        files,
        (file) => discoverFile(context, file, output),
        { concurrency: context.concurrency },
      )
      const moduleFailures = failed.filter((file) => file !== null)
      const cases = parseNodeDiscoveryRecords(
        context.root,
        yield* fs.readFileString(output),
      )
      if (cases.length === 0 && moduleFailures.length === 0) return null
      return {
        aggregate: false,
        cases,
        coverageFiles: [],
        moduleFailures,
        success: moduleFailures.length === 0,
      } satisfies NodeDiscovery
    }),
  ).pipe(
    Effect.orElseSucceed((): NodeDiscovery => ({
      ...failedExecution(context, files),
      aggregate: false,
    })),
  )

const discover = Effect.fnUntraced(function* (
  context: NodeContext,
  files: readonly string[],
) {
  if (nodeDiscoveryHooksSupported()) {
    const discovery = yield* discoverWithHooks(context, files)
    if (discovery !== null) return discovery
  }
  const aggregate = yield* executeNode(context, files, undefined)
  return { ...aggregate, aggregate: true } satisfies NodeDiscovery
})

function matchesCandidate(candidate: NodeCase, item: NodeCase): boolean {
  return (
    item.id === candidate.id ||
    item.fullName === candidate.fullName ||
    item.fullName === candidate.name ||
    candidate.fullName.endsWith(` ${item.fullName}`)
  )
}

const observeCandidate = Effect.fnUntraced(function* (
  context: NodeContext,
  candidate: NodeCase,
) {
  if (candidate.state === 'skipped') {
    return observationOf(candidate, [candidate.file])
  }
  const execution = yield* executeNode(
    context,
    [resolve(context.root, candidate.file)],
    new RegExp(`^${escapeRegExp(candidate.fullName)}$`, 'u'),
  )
  const executed = execution.cases.find((item) =>
    matchesCandidate(candidate, item),
  )
  if (executed === undefined && context.log) {
    console.error(
      `TIA node could not match ${JSON.stringify(candidate)} against ${JSON.stringify(execution)}.`,
    )
  }
  const result: NodeCase =
    executed === undefined
      ? { ...candidate, state: 'failed' }
      : {
          ...executed,
          column: candidate.column,
          file: candidate.file,
          fullName: candidate.fullName,
          id: candidate.id,
          line: candidate.line,
        }
  return observationOf(result, [candidate.file, ...execution.coverageFiles])
})

/**
 * Observes test files. With discovery hooks each discovered case runs alone in
 * its own child (cases of one file in order, files in parallel); without them
 * one child runs every file and each case depends on everything that run
 * touched. The aggregate path cannot vouch for the run when any file failed to
 * load, crashed or timed out: it reports `complete: false`.
 */
export const observeNodeFiles = Effect.fnUntraced(function* (
  context: NodeContext,
  files: readonly string[],
) {
  if (files.length === 0) {
    return { complete: true, observations: [] } satisfies FileObservations
  }
  const discovery = yield* discover(context, files)

  if (discovery.aggregate) {
    return {
      complete: discovery.moduleFailures.length === 0,
      observations: discovery.cases.map((testCase) =>
        observationOf(testCase, [testCase.file, ...discovery.coverageFiles]),
      ),
    } satisfies FileObservations
  }

  const groups = groupBy(discovery.cases, (candidate) => candidate.file)
  const perFile = yield* Effect.forEach(
    [...groups.values()],
    (candidates) =>
      Effect.gen(function* () {
        const observations: TiaObservation[] = []
        for (const candidate of candidates) {
          observations.push(yield* observeCandidate(context, candidate))
        }
        return observations
      }),
    { concurrency: context.concurrency },
  )
  const observations = perFile.flat()
  const observedFiles = new Set(observations.map((item) => item.file))
  for (const file of discovery.moduleFailures) {
    if (!observedFiles.has(file)) {
      observations.push(moduleFailureObservation(file))
    }
  }
  return { complete: true, observations } satisfies FileObservations
})

const observeCachedCase = Effect.fnUntraced(function* (
  context: NodeContext,
  cached: CachedTestResult,
) {
  const moduleFailure = cached.id === `module:${cached.file}`
  const execution = yield* executeNode(
    context,
    [resolve(context.root, cached.file)],
    moduleFailure
      ? undefined
      : new RegExp(`^${escapeRegExp(cached.fullName)}$`, 'u'),
  )
  if (moduleFailure && execution.cases.length > 0) {
    return execution.cases.map((testCase) =>
      observationOf(testCase, [cached.file, ...execution.coverageFiles]),
    )
  }
  const executed = execution.cases.find(
    (item) =>
      item.id === cached.id ||
      item.fullName === cached.fullName ||
      cached.fullName.endsWith(` ${item.fullName}`),
  )
  if (executed !== undefined) {
    return [
      observationOf({ ...executed, fullName: cached.fullName, id: cached.id }, [
        cached.file,
        ...execution.coverageFiles,
      ]),
    ]
  }
  return execution.moduleFailures.map(moduleFailureObservation)
})

/** Re-runs affected cached cases, grouped by file: files in parallel, cases in order. */
export const observeNodeCachedCases = Effect.fnUntraced(function* (
  context: NodeContext,
  cached: readonly CachedTestResult[],
) {
  const groups = groupBy(cached, (result) => result.file)
  const perFile = yield* Effect.forEach(
    [...groups.values()],
    (results) =>
      Effect.gen(function* () {
        const observations: TiaObservation[] = []
        for (const result of results) {
          observations.push(...(yield* observeCachedCase(context, result)))
        }
        return observations
      }),
    { concurrency: context.concurrency },
  )
  return perFile.flat()
})
