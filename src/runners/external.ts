import { createHash } from 'node:crypto'
import { dirname, relative, resolve, sep } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { glob } from 'tinyglobby'

import { byCodeUnit } from '../core/canonical.ts'
import { freshRequested } from '../core/env.ts'
import type {
  ExternalPlanFields,
  ExternalSuitesResult,
} from '../core/external.ts'
import type { TiaSuiteOutcome } from '../core/verification.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaImpactPlan,
  TiaImpactPlanInput,
  TiaInvalidator,
  TiaSuiteDescriptor,
} from '../core/protocol.ts'
import { TIA_PROTOCOL_VERSION } from '../core/protocol.ts'
import { createImpactPlan } from '../engine/plan/protocol.ts'
import { aggregateStatus, executeSuites } from '../engine/scheduling.ts'
import {
  verificationTarget,
  writeProtocolVerificationSnapshot,
} from '../engine/verification-snapshot.ts'
import { parseImpactGraph } from '../wire/decode.ts'
import {
  errorMessage,
  systemIoError,
  TiaInvalid,
  TiaIo,
} from '../wire/errors.ts'

/** Runs a computation that throws 1.x-style errors, keeping the message. */
export function attempt<A>(compute: () => A): Effect.Effect<A, TiaInvalid> {
  return Effect.try({
    catch: (error) =>
      new TiaInvalid({
        message: errorMessage(error),
      }),
    try: compute,
  })
}

/**
 * The options a run plans with: `TIA_FRESH` asks for a full run exactly as
 * `forceFull` does, like it does in every other runner.
 */
export function withFresh<Options extends { forceFull?: boolean }>(
  options: Options,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Options {
  return freshRequested(env) ? { ...options, forceFull: true } : options
}

/** sha256 over the suites sorted by id; the descriptors' key order is part of it. */
export function catalogFingerprint(
  suites: readonly { readonly id: string }[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...suites].sort((left, right) => byCodeUnit(left.id, right.id)),
      ),
    )
    .digest('hex')
}

/** The protocol-visible part of an adapter suite. */
export function protocolSuite(suite: TiaSuiteDescriptor): TiaSuiteDescriptor {
  return {
    adapter: suite.adapter,
    ...(suite.dependsOn === undefined ? {} : { dependsOn: suite.dependsOn }),
    file: suite.file,
    id: suite.id,
    project: suite.project,
    ...(suite.resourceLocks === undefined
      ? {}
      : { resourceLocks: suite.resourceLocks }),
    ...(suite.tags === undefined ? {} : { tags: suite.tags }),
  }
}

export interface ExternalGraphParts {
  environmentFingerprint: string
  fingerprint: string
  invalidators: TiaInvalidator[]
  knownSources: string[]
  observations: TiaDependencyObservation[]
  suites: TiaSuiteDescriptor[]
  complete?: boolean
}

/** Assembles a protocol v1 graph in the key order 1.x wrote. */
export function externalGraph(parts: ExternalGraphParts): TiaImpactGraph {
  return {
    complete: parts.complete ?? true,
    environmentFingerprint: parts.environmentFingerprint,
    fingerprint: parts.fingerprint,
    invalidators: parts.invalidators,
    knownSources: parts.knownSources,
    observations: parts.observations,
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites: parts.suites,
  }
}

/** The planner call every external adapter makes, with its policy defaults. */
export function planExternal(
  provider: string,
  suites: TiaSuiteDescriptor[],
  options: ExternalPlanFields & { allowedSuites?: string[] | undefined },
): Effect.Effect<TiaImpactPlan, TiaInvalid> {
  const input: TiaImpactPlanInput = {
    catalog: suites,
    changes: { files: options.changes, provider },
    currentEnvironmentFingerprint: options.currentEnvironmentFingerprint,
    currentFingerprint:
      options.currentFingerprint ?? catalogFingerprint(suites),
    graph: options.graph,
    policy: {
      ...(options.allowedSuites === undefined
        ? {}
        : { allowedSuites: options.allowedSuites }),
      forceFull: options.forceFull ?? false,
      ignoreChanges: options.ignoreChanges ?? [],
      onUnknownChange: options.onUnknownChange ?? 'full',
    },
  }
  return attempt(() => createImpactPlan(input))
}

/** Globs with tinyglobby; a failure is a TiaIo. */
export function globFiles(
  patterns: readonly string[],
  options: { cwd: string; ignore?: string[] },
): Effect.Effect<string[], TiaIo> {
  return Effect.tryPromise({
    catch: (error) =>
      new TiaIo({
        message: errorMessage(error),
      }),
    try: () =>
      glob([...patterns], {
        absolute: true,
        cwd: options.cwd,
        ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
        onlyFiles: true,
      }),
  })
}

/** A platform failure as the TiaIo that carries Node's own message. */
export function ioFailure(error: PlatformError.PlatformError): TiaIo {
  return systemIoError(error)
}

/** Reads a recorded graph; a missing, unreadable or invalid file is no graph. */
export const readAdapterGraph = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.map((text): TiaImpactGraph | null => {
      try {
        return parseImpactGraph(JSON.parse(text))
      } catch {
        return null
      }
    }),
    Effect.orElseSucceed((): TiaImpactGraph | null => null),
  )
})

/** Promotes a graph atomically: write a temporary file, then rename it. */
export const writeAdapterGraph = Effect.fnUntraced(function* (
  path: string,
  graph: TiaImpactGraph,
) {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${path}.${process.pid}.tmp`
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(path), { recursive: true })
    yield* fs.writeFileString(temporary, `${JSON.stringify(graph, null, 2)}\n`)
    yield* fs.rename(temporary, path)
  }).pipe(
    Effect.tapError(() => Effect.ignore(fs.remove(temporary, { force: true }))),
    Effect.mapError(ioFailure),
  )
})

/**
 * The name `tiacore verify` knows a suite-granular runner by: its adapter and
 * the state file it keeps, which tells two lanes of one command apart.
 */
export function verificationRunnerName(
  name: string,
  root: string,
  graphPath: string,
): string {
  return `${name}:${relative(root, graphPath).split(sep).join('/')}`
}

/** What an adapter decided before any suite runs. */
export interface PreparedSuites<Suite extends TiaSuiteDescriptor> {
  readonly plan: TiaImpactPlan
  /** The graph to record after a run in which every suite passed. */
  readonly recordGraph: () => TiaImpactGraph
  readonly suites: Suite[]
}

export interface ExternalSuitesRun<
  Suite extends TiaSuiteDescriptor,
  Failure,
  Requirements,
> {
  /** The argument list before the suite file when the caller gives none. */
  readonly defaultArguments: readonly string[]
  /** Names the command and the default graph path, `.tia/<name>/graph.json`. */
  readonly name: string
  readonly options: {
    readonly command?: string
    readonly commandArguments?: string[]
    readonly environment?: NodeJS.ProcessEnv
    readonly graph?: TiaImpactGraph | null
    readonly graphPath?: string
    readonly maxConcurrency?: number
    readonly root: string
  }
  /** Discovers and plans against the graph read (or given) for this run. */
  readonly prepare: (
    graph: TiaImpactGraph | null,
  ) => Effect.Effect<PreparedSuites<Suite>, Failure, Requirements>
}

/**
 * The run shared by the adapters that execute suites as commands (k6,
 * Maestro): read the prior graph, plan, run the selected suites, and record a
 * new graph only when every suite passed.
 */
export const runExternal = Effect.fnUntraced(function* <
  Suite extends TiaSuiteDescriptor,
  Failure,
  Requirements,
>(run: ExternalSuitesRun<Suite, Failure, Requirements>) {
  const { options } = run
  const verification = yield* verificationTarget(process.env)
  const root = resolve(options.root)
  const graphPath = resolve(
    root,
    options.graphPath ?? `.tia/${run.name}/graph.json`,
  )
  const graph =
    options.graph === undefined
      ? yield* readAdapterGraph(graphPath)
      : options.graph
  const { plan, recordGraph, suites } = yield* run.prepare(graph)
  const selected = new Set(plan.selected)
  const executions = yield* executeSuites({
    argumentsFor: (suite) => [
      ...(options.commandArguments ?? run.defaultArguments),
      resolve(root, suite.file),
    ],
    command: options.command ?? run.name,
    cwd: root,
    environment: options.environment,
    maxConcurrency: options.maxConcurrency ?? 1,
    suites: suites.filter((suite) => selected.has(suite.id)),
  })
  const status = aggregateStatus(executions)
  // A failed run promotes no graph, but a verification still compares the one
  // it would have recorded.
  if (status === 0 || verification !== undefined) {
    const recorded = recordGraph()
    if (status === 0) yield* writeAdapterGraph(graphPath, recorded)
    yield* writeProtocolVerificationSnapshot({
      executed: executions.map((execution) => execution.suiteId),
      graph: recorded,
      outcomes: Object.fromEntries(
        executions.map((execution): [string, TiaSuiteOutcome] => [
          execution.suiteId,
          execution.status === 0 ? 'passed' : 'failed',
        ]),
      ),
      plan,
      runner: verificationRunnerName(run.name, root, graphPath),
      success: status === 0,
      target: verification,
    })
  }
  const result: ExternalSuitesResult = {
    executions,
    plan,
    status,
    success: status === 0,
  }
  return result
})
