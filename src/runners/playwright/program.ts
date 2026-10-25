import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'

import type { RunPlan } from '../../core/runtime.ts'
import {
  TIA_EVIDENCE_DIRECTORY_ENV,
  TIA_EVIDENCE_HEADER_ENV,
} from '../../evidence/index.ts'
import { TiaCore } from '../../engine/core.ts'
import {
  frameworkAdapters,
  frameworkFingerprint,
} from '../../engine/edges/index.ts'
import { resolveFrameworkEdges } from '../../engine/edges/resolve.ts'
import { formatRunPlanDetails } from '../../engine/explain.ts'
import { slash } from '../../engine/host-path.ts'
import { replayedResults } from '../../engine/replay.ts'
import { TiaInvalid, TiaIo } from '../../wire/errors.ts'
import {
  importedFilesFingerprint,
  importedProjectFiles,
  type ImportMemo,
} from './imports.ts'
import { configuredRunnerName } from './names.ts'
import {
  PLAYWRIGHT_ROOT_ENV,
  PLAYWRIGHT_SESSION_ENV,
  type PlaywrightObservation,
} from './protocol.ts'
import { evidenceProblems, readReport } from './report.ts'
import { spawnStatus } from './spawn.ts'
import type { TiaPlaywrightOptions, TiaPlaywrightResult } from './types.ts'

/**
 * Longest path-filter list handed to Playwright. A longer one (operating
 * systems cap the argument list) is replaced by a full run, said out loud.
 */
export const MAX_FILTER_CHARACTERS = 24_000

function pathFilter(file: string): string {
  return file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function playwrightCli(cwd: string): string {
  return createRequire(resolve(cwd, 'package.json')).resolve(
    '@playwright/test/cli',
  )
}

function nodeExecutable(): string {
  const npmNode = process.env['npm_node_execpath']
  return npmNode !== undefined && /(?:^|[\\/])node(?:\.exe)?$/iu.test(npmNode)
    ? npmNode
    : 'node'
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Cached tests a replay reuses. Playwright reruns every test of an affected
 * spec file, so a sibling of an affected test is not cached even though the
 * planner counts it as replayable.
 */
export function cachedTestCount(plan: RunPlan): number {
  const affected = new Set(plan.affectedTests)
  return replayedResults(plan).filter((result) => !affected.has(result.file))
    .length
}

function logPlan(plan: RunPlan): void {
  if (plan.mode === 'record') {
    console.log(`TIA record: ${plan.reason}.`)
  } else {
    console.log(
      `TIA replay: ${plural(plan.affectedTests.length, 'affected file')}, ${plural(
        cachedTestCount(plan),
        'cached test',
      )}.`,
    )
  }
  for (const line of formatRunPlanDetails(plan)) console.log(line)
}

export interface PlaywrightFilters {
  readonly filters: string[]
  /** Set when the filters were dropped and Playwright runs every spec. */
  readonly note?: string
}

/**
 * The positional path filters for a plan: none for a record, one escaped
 * absolute path per affected spec for a replay. A list longer than
 * MAX_FILTER_CHARACTERS is dropped for a full run that says why; 1.x dropped it
 * without a word (PW-RUN-10).
 */
export function planFilters(plan: RunPlan, root: string): PlaywrightFilters {
  if (plan.mode === 'record') return { filters: [] }
  const filters = plan.affectedTests.map((file) =>
    pathFilter(resolve(root, file)),
  )
  if (filters.join('').length <= MAX_FILTER_CHARACTERS) return { filters }
  return {
    filters: [],
    note: `the ${plural(filters.length, 'affected spec path')} exceed ${MAX_FILTER_CHARACTERS} characters, so Playwright runs every spec`,
  }
}

/** The failure text of a rejected TiaCore call, with the message 1.x printed. */
function engineFailure(error: unknown): TiaIo {
  return new TiaIo({
    cause: error,
    message: error instanceof Error ? error.message : String(error),
  })
}

function enginePromise<A>(call: () => Promise<A>) {
  return Effect.tryPromise({ catch: engineFailure, try: call })
}

function runnerFingerprint(
  configFingerprint: string,
  adapters: ReturnType<typeof frameworkAdapters>,
  evidenceDirectory: string | undefined,
  evidenceHeader: string | undefined,
): string {
  return createHash('sha256')
    .update(configFingerprint)
    .update(frameworkFingerprint(adapters))
    .update(
      JSON.stringify({
        correlatedEvidence: evidenceDirectory === undefined ? 0 : 1,
        evidenceHeader: evidenceHeader ?? '',
        version: 1,
      }),
    )
    .digest('hex')
}

interface Resolved {
  readonly cacheDir: string
  readonly config: string
  readonly cwd: string
  readonly evidenceDirectory: string | undefined
  readonly evidenceHeader: string | undefined
  readonly log: boolean
  readonly root: string
  readonly runner: string
}

function resolved(options: TiaPlaywrightOptions) {
  return Effect.try({
    catch: (error) =>
      new TiaInvalid({
        message: error instanceof Error ? error.message : String(error),
      }),
    try: (): Resolved => {
      const root = resolve(options.root ?? process.cwd())
      const cwd = resolve(root, options.cwd ?? '.')
      const config = resolve(cwd, options.config ?? 'playwright.config.ts')
      return {
        cacheDir: resolve(root, options.cacheDir ?? '.tia'),
        config,
        cwd,
        evidenceDirectory:
          options.evidenceDirectory ?? process.env[TIA_EVIDENCE_DIRECTORY_ENV],
        evidenceHeader:
          options.evidenceHeader ?? process.env[TIA_EVIDENCE_HEADER_ENV],
        log: options.log ?? true,
        root,
        runner: configuredRunnerName(basename(config), options.name),
      }
    },
  })
}

/**
 * Per-observation file lists: the runtime files the fixture recorded, the
 * spec's static relative-import closure, and the framework edge adapters'
 * files. The closure is computed once per spec, not once per test.
 */
const observationsWithEdges = Effect.fnUntraced(function* (
  observations: readonly PlaywrightObservation[],
  adapters: ReturnType<typeof frameworkAdapters>,
  root: string,
) {
  const closures = new Map<string, string[]>()
  const memo: ImportMemo = new Map()
  const files: PlaywrightObservation[] = []
  let complete = true
  for (const observation of observations) {
    let closure = closures.get(observation.file)
    if (closure === undefined) {
      closure = yield* Effect.promise(() =>
        importedProjectFiles(resolve(root, observation.file), root, memo),
      )
      closures.set(observation.file, closure)
    }
    const runtimeFiles = [...new Set([...observation.files, ...closure])].sort()
    const framework = resolveFrameworkEdges(adapters, {
      files: runtimeFiles,
      root,
      testFile: observation.file,
    })
    complete &&= framework.complete
    files.push({
      ...observation,
      dependenciesComplete:
        observation.dependenciesComplete && framework.complete,
      files: [...new Set([...runtimeFiles, ...framework.files])].sort(),
    })
  }
  return { complete, observations: files }
})

/**
 * One adapter run: plan from the stored graph, run Playwright over the
 * affected spec files (or all of them), and commit what the specs touched.
 * Playwright keeps its workers, retries, projects and web servers; tiacore
 * adds `--config` and the file filters.
 */
export const run = Effect.fn('tia.playwright.run')(function* (
  options: TiaPlaywrightOptions,
  runArguments: readonly string[],
) {
  const settings = yield* resolved(options)
  const { cacheDir, config, cwd, root, runner } = settings
  const adapters = frameworkAdapters(options.frameworks)
  const configFingerprint = yield* Effect.promise(() =>
    importedFilesFingerprint(config, root),
  )
  const core = new TiaCore({
    ...(options.artifacts === undefined
      ? {}
      : { artifacts: options.artifacts }),
    ...(options.artifactTrust === undefined
      ? {}
      : { artifactTrust: options.artifactTrust }),
    cacheDir,
    files: [slash(relative(root, config)), ...runArguments],
    fingerprint: runnerFingerprint(
      configFingerprint,
      adapters,
      settings.evidenceDirectory,
      settings.evidenceHeader,
    ),
    ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
    ...(options.ignoreChanges === undefined
      ? {}
      : { ignoreChanges: options.ignoreChanges }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.onUnknownChange === undefined
      ? {}
      : { onUnknownChange: options.onUnknownChange }),
    root,
    runner,
  })
  const plan = yield* enginePromise(() => core.prepare())
  if (settings.log) logPlan(plan)
  const notes: string[] = []

  if (plan.mode === 'replay' && plan.affectedTests.length === 0) {
    yield* enginePromise(() => core.commit([], []))
    return {
      notes,
      plan,
      status: 0,
      success: true,
    } satisfies TiaPlaywrightResult
  }

  const runtimeDirectory = resolve(cacheDir, 'runtime')
  const session = resolve(
    runtimeDirectory,
    `${runner}-${process.pid}-${randomUUID()}.json`,
  )
  const selected = planFilters(plan, root)
  const filters = selected.filters
  if (selected.note !== undefined) {
    notes.push(selected.note)
    if (settings.log) console.log(`TIA full run: ${selected.note}.`)
  }

  return yield* Effect.gen(function* () {
    yield* Effect.try({
      catch: engineFailure,
      try: () => mkdirSync(runtimeDirectory, { recursive: true }),
    })
    const cliPath = yield* Effect.try({
      catch: engineFailure,
      try: () => playwrightCli(cwd),
    })
    const status = yield* spawnStatus({
      arguments: [
        cliPath,
        'test',
        '--config',
        config,
        ...runArguments,
        ...filters,
      ],
      command: nodeExecutable(),
      cwd,
      environment: {
        ...process.env,
        ...(settings.evidenceDirectory === undefined
          ? {}
          : {
              [TIA_EVIDENCE_DIRECTORY_ENV]: resolve(
                root,
                settings.evidenceDirectory,
              ),
            }),
        ...(settings.evidenceHeader === undefined
          ? {}
          : { [TIA_EVIDENCE_HEADER_ENV]: settings.evidenceHeader }),
        [PLAYWRIGHT_ROOT_ENV]: root,
        [PLAYWRIGHT_SESSION_ENV]: session,
      },
    })

    const skipped = (reasons: readonly string[], message: string) => {
      notes.push(...reasons)
      if (settings.log) {
        console.warn(message)
        for (const reason of reasons) console.warn(`TIA detail: ${reason}.`)
      }
      return { notes, plan, status, success: status === 0 }
    }

    const report = readReport(session)
    const problems = evidenceProblems(report, root)
    if (report === null || problems.length > 0) {
      return skipped(
        problems,
        'TIA graph was not updated because Playwright dependency evidence was incomplete.',
      )
    }

    const edges = yield* observationsWithEdges(
      report.observations,
      adapters,
      root,
    )
    if (!edges.complete) {
      return skipped(
        ['a framework edge adapter threw while resolving a spec'],
        'TIA graph was not updated because a Playwright framework edge adapter failed.',
      )
    }
    yield* enginePromise(() =>
      core.commit(edges.observations, [
        ...new Set(edges.observations.map((entry) => entry.file)),
      ]),
    )
    return { notes, plan, status, success: status === 0 }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (existsSync(session)) rmSync(session, { force: true })
      }),
    ),
  )
})
