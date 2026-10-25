import { dirname, extname, relative, resolve } from 'node:path'

import { parse } from 'es-module-lexer'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

import { byCodeUnit } from '../../core/canonical.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaImpactPlan,
} from '../../core/protocol.ts'
import { normalizeProtocolPath } from '../../engine/plan/protocol.ts'
import { aggregateStatus, executeSuites } from '../../engine/scheduling.ts'
import { TiaInvalid } from '../../wire/errors.ts'
import {
  attempt,
  catalogFingerprint,
  externalGraph,
  globFiles,
  ioFailure,
  planExternal,
  protocolSuite,
  readAdapterGraph,
  writeAdapterGraph,
} from '../external.ts'
import type {
  DiscoverK6Options,
  K6GraphOptions,
  K6Suite,
  PlanK6Options,
  TiaK6Options,
} from './types.ts'

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.ts'] as const

const existingImportPath = Effect.fnUntraced(function* (
  importer: string,
  specifier: string,
) {
  if (!specifier.startsWith('.')) return null
  const fs = yield* FileSystem.FileSystem
  const unresolved = resolve(dirname(importer), specifier)
  const candidates =
    extname(unresolved) === ''
      ? SCRIPT_EXTENSIONS.map((extension) => `${unresolved}${extension}`)
      : [unresolved]
  for (const candidate of candidates) {
    const found = yield* fs
      .exists(candidate)
      .pipe(Effect.orElseSucceed(() => false))
    if (found) return candidate
  }
  return null
})

/** The files a profile reaches through local imports, or the file that would not lex. */
export type ImportScan =
  | { readonly _tag: 'Scanned'; readonly files: readonly string[] }
  | {
      readonly _tag: 'Unlexable'
      readonly file: string
      readonly message: string
    }

type Lexed =
  | { readonly _tag: 'Failed'; readonly message: string }
  | { readonly _tag: 'Lexed'; readonly imports: ReturnType<typeof parse>[0] }

function lexImports(source: string): Lexed {
  try {
    return { _tag: 'Lexed', imports: parse(source)[0] }
  } catch (error) {
    return {
      _tag: 'Failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** What one file imports locally, or why it cannot be lexed. */
type FileImports =
  | { readonly _tag: 'Failed'; readonly message: string }
  | { readonly _tag: 'Imports'; readonly next: readonly string[] }

/** Lexed files of one scan session, so a shared module is read once. */
export type ImportCache = Map<string, FileImports>

const importsOf = Effect.fnUntraced(function* (
  root: string,
  path: string,
  cache: ImportCache,
) {
  const known = cache.get(path)
  if (known !== undefined) return known
  const fs = yield* FileSystem.FileSystem
  const source = yield* fs.readFileString(path).pipe(Effect.mapError(ioFailure))
  const lexed = lexImports(source)
  if (lexed._tag === 'Failed') {
    cache.set(path, lexed)
    return lexed
  }
  const next: string[] = []
  for (const imported of lexed.imports) {
    if (
      imported.type === 'import-meta' ||
      imported.specifier === undefined ||
      (imported.type === 'dynamic' && imported.glob) ||
      (imported.type !== 'dynamic' && imported.typeOnly)
    ) {
      continue
    }
    const resolved = yield* existingImportPath(path, imported.specifier)
    if (resolved === null) continue
    const projectFile = yield* attempt(() =>
      normalizeProtocolPath(relative(root, resolved)),
    )
    next.push(resolve(root, projectFile))
  }
  const entry: FileImports = { _tag: 'Imports', next }
  cache.set(path, entry)
  return entry
})

export const scanImports = Effect.fnUntraced(function* (
  root: string,
  entry: string,
  cache: ImportCache = new Map(),
) {
  const visited = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined || visited.has(path)) continue
    visited.add(path)
    const imports = yield* importsOf(root, path, cache)
    if (imports._tag === 'Failed') {
      return {
        _tag: 'Unlexable',
        file: normalizeProtocolPath(relative(root, path)),
        message: imports.message,
      } satisfies ImportScan
    }
    for (const absolute of imports.next) {
      if (!visited.has(absolute)) pending.push(absolute)
    }
  }
  const files: string[] = []
  for (const path of visited) {
    files.push(normalizeProtocolPath(relative(root, path)))
  }
  return {
    _tag: 'Scanned',
    files: files.sort(byCodeUnit),
  } satisfies ImportScan
})

function suiteId(project: string, file: string): string {
  return `k6:${project}:${file}`
}

export const discover = Effect.fnUntraced(function* (
  options: DiscoverK6Options,
) {
  const root = resolve(options.root)
  const profileRoot = resolve(root, options.profiles)
  const paths = yield* globFiles(['*.js', '*.mjs', '*.ts'], {
    cwd: profileRoot,
  })
  const suites: K6Suite[] = []
  for (const path of paths.sort()) {
    const file = yield* attempt(() =>
      normalizeProtocolPath(relative(root, path)),
    )
    suites.push({
      adapter: 'k6',
      file,
      id: suiteId(options.project, file),
      profile: file.replace(/^.*\//u, '').replace(/\.[^.]+$/u, ''),
      project: options.project,
      resourceLocks: ['performance-host'],
    })
  }
  return suites
})

/** Scans every suite's imports; the first unlexable file is reported. */
const scanSuites = Effect.fnUntraced(function* (
  root: string,
  suites: readonly K6Suite[],
) {
  const scans: { suite: K6Suite; scan: ImportScan }[] = []
  const cache: ImportCache = new Map()
  for (const suite of suites) {
    scans.push({
      scan: yield* scanImports(root, resolve(root, suite.file), cache),
      suite,
    })
  }
  return scans
})

function graphFromScans(
  scans: readonly { suite: K6Suite; scan: ImportScan }[],
  options: K6GraphOptions,
  complete: boolean,
): TiaImpactGraph {
  const observations: TiaDependencyObservation[] = []
  for (const { scan, suite } of scans) {
    if (scan._tag === 'Unlexable') continue
    for (const source of scan.files) {
      observations.push({
        confidence: 'exact',
        kind: source === suite.file ? 'configuration' : 'import',
        source,
        suiteId: suite.id,
      })
    }
  }
  return externalGraph({
    complete,
    environmentFingerprint: options.environmentFingerprint,
    fingerprint: options.fingerprint ?? catalogFingerprint(options.suites),
    invalidators: options.invalidators ?? [],
    knownSources: options.knownSources ?? [],
    observations: [...observations, ...(options.observations ?? [])],
    suites: options.suites.map(protocolSuite),
  })
}

export const createGraph = Effect.fnUntraced(function* (
  rootValue: string,
  options: K6GraphOptions,
) {
  const root = resolve(rootValue)
  const scans = yield* scanSuites(root, options.suites)
  for (const { scan } of scans) {
    if (scan._tag === 'Unlexable') {
      return yield* new TiaInvalid({ message: scan.message })
    }
  }
  return graphFromScans(scans, options, true)
})

export const planSuites = Effect.fnUntraced(function* (
  suites: readonly K6Suite[],
  options: PlanK6Options,
) {
  const allowedProfiles = options.allowedProfiles
  const allowed =
    allowedProfiles === undefined
      ? undefined
      : suites
          .filter((suite) => allowedProfiles.includes(suite.profile))
          .map((suite) => suite.id)
  if (
    allowedProfiles !== undefined &&
    allowed?.length !== new Set(allowedProfiles).size
  ) {
    return yield* new TiaInvalid({
      message: 'k6 policy names an unknown or duplicate profile',
    })
  }
  return yield* planExternal('k6', [...suites], {
    allowedSuites: allowed,
    changes: options.changes,
    currentEnvironmentFingerprint: options.currentEnvironmentFingerprint,
    currentFingerprint: options.currentFingerprint,
    forceFull: options.forceFull,
    graph: options.graph,
    ignoreChanges: options.ignoreChanges,
    onUnknownChange: options.onUnknownChange,
  })
})

export const run = Effect.fn('tia.k6.run')(function* (options: TiaK6Options) {
  const root = resolve(options.root)
  const graphPath = resolve(root, options.graphPath ?? '.tia/k6/graph.json')
  const graph =
    options.graph === undefined
      ? yield* readAdapterGraph(graphPath)
      : options.graph
  const suites = yield* discover(options)
  const scans = yield* scanSuites(root, suites)
  const unlexable = scans.flatMap(({ scan }) =>
    scan._tag === 'Unlexable' ? [scan] : [],
  )[0]
  const planned = yield* planSuites(suites, {
    ...options,
    ...(unlexable === undefined ? {} : { forceFull: true }),
    graph,
  })
  const plan: TiaImpactPlan =
    unlexable === undefined
      ? planned
      : fullPlan(
          planned,
          `k6 import analysis failed for ${unlexable.file}: ${unlexable.message}`,
        )
  const selected = new Set(plan.selected)
  const executions = yield* executeSuites({
    argumentsFor: (suite) => [
      ...(options.commandArguments ?? ['run']),
      resolve(root, suite.file),
    ],
    command: options.command ?? 'k6',
    cwd: root,
    environment: options.environment,
    maxConcurrency: options.maxConcurrency ?? 1,
    suites: suites.filter((suite) => selected.has(suite.id)),
  })
  const status = aggregateStatus(executions)
  if (status === 0) {
    yield* writeAdapterGraph(
      graphPath,
      graphFromScans(
        scans,
        {
          environmentFingerprint: options.currentEnvironmentFingerprint,
          ...(options.currentFingerprint === undefined
            ? {}
            : { fingerprint: options.currentFingerprint }),
          suites,
        },
        unlexable === undefined,
      ),
    )
  }
  return { executions, plan, status, success: status === 0 }
})

function fullPlan(plan: TiaImpactPlan, reason: string): TiaImpactPlan {
  return {
    ...plan,
    reason,
    reasons: Object.fromEntries(plan.selected.map((id) => [id, [reason]])),
  }
}
