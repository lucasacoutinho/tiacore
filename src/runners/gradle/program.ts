import { basename, dirname, extname, relative, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import { XMLParser } from 'fast-xml-parser'

import { byCodeUnit } from '../../core/canonical.ts'
import type {
  TiaDependencyObservation,
  TiaImpactGraph,
  TiaInvalidator,
} from '../../core/protocol.ts'
import type { TiaSuiteOutcome } from '../../core/verification.ts'
import { normalizeProtocolPath } from '../../engine/plan/protocol.ts'
import { inheritedEnvironment, runAttached } from '../../engine/process.ts'
import {
  verificationTarget,
  writeProtocolVerificationSnapshot,
} from '../../engine/verification-snapshot.ts'
import {
  attempt,
  catalogFingerprint,
  externalGraph,
  globFiles,
  ioFailure,
  planExternal,
  readAdapterGraph,
  verificationRunnerName,
  withFresh,
  writeAdapterGraph,
} from '../external.ts'
import type {
  DiscoverGradleOptions,
  GradleGraphOptions,
  GradleSuite,
  JUnitCase,
  PlanGradleOptions,
  TiaGradleOptions,
} from './types.ts'
import { isRecord } from '../../core/record.ts'

const DEFAULT_TESTS = [
  '**/src/test/**/*.{java,kt}',
  '**/src/androidTest/**/*.{java,kt}',
]
const DEFAULT_SOURCES = ['**/src/main/**/*.{java,kt}']
export const DEFAULT_REPORTS = ['**/build/test-results/**/*.xml']
const GRADLE_INVALIDATORS: TiaInvalidator[] = [
  { pattern: '**/*.gradle', reason: 'Gradle build configuration changed' },
  { pattern: '**/*.gradle.kts', reason: 'Gradle build configuration changed' },
  { pattern: '**/gradle.properties', reason: 'Gradle properties changed' },
  { pattern: '**/settings.gradle', reason: 'Gradle settings changed' },
  { pattern: '**/settings.gradle.kts', reason: 'Gradle settings changed' },
]

interface SourceDescriptor {
  className: string
  file: string
  imports: string[]
}

function descriptor(file: string, source: string): SourceDescriptor {
  const packageName = /^\s*package\s+([A-Za-z_][\w.]*)/mu.exec(source)?.[1]
  const declaredName =
    /^\s*(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|enum|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/mu.exec(
      source,
    )?.[1] ?? basename(file, extname(file))
  const imports: string[] = []
  for (const match of source.matchAll(
    /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.*]*)/gmu,
  )) {
    if (match[1] !== undefined) imports.push(match[1])
  }
  return {
    className: packageName ? `${packageName}.${declaredName}` : declaredName,
    file,
    imports,
  }
}

const sourceDescriptors = Effect.fnUntraced(function* (
  root: string,
  patterns: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem
  const files = yield* globFiles(patterns, {
    cwd: root,
    ignore: ['**/build/**', '**/node_modules/**'],
  })
  return yield* Effect.forEach(
    files.sort(),
    (absolute) =>
      Effect.gen(function* () {
        const source = yield* fs
          .readFileString(absolute)
          .pipe(Effect.mapError(ioFailure))
        const file = yield* attempt(() =>
          normalizeProtocolPath(relative(root, absolute)),
        )
        return descriptor(file, source)
      }),
    { concurrency: 16 },
  )
})

function suiteId(project: string, file: string): string {
  return `gradle-junit:${project}:${file}`
}

export const discover = Effect.fnUntraced(function* (
  options: DiscoverGradleOptions,
) {
  const root = resolve(options.root)
  const tests = yield* sourceDescriptors(root, options.tests ?? DEFAULT_TESTS)
  return tests
    .map((test): GradleSuite => ({
      adapter: 'gradle-junit',
      className: test.className,
      file: test.file,
      id: suiteId(options.project, test.file),
      project: options.project,
    }))
    .sort((left, right) => byCodeUnit(left.id, right.id))
})

export const createGraph = Effect.fnUntraced(function* (
  rootValue: string,
  options: GradleGraphOptions,
) {
  const root = resolve(rootValue)
  const tests = yield* sourceDescriptors(
    root,
    options.suites.map((suite) => suite.file),
  )
  const sources = yield* sourceDescriptors(
    root,
    options.sources ?? DEFAULT_SOURCES,
  )
  const testsByFile = new Map<string, SourceDescriptor>()
  for (const test of tests) {
    if (!testsByFile.has(test.file)) testsByFile.set(test.file, test)
  }
  const byClass = new Map(sources.map((source) => [source.className, source]))
  const importedSource = (name: string): SourceDescriptor | undefined => {
    const parts = name.replace(/\.\*$/u, '').split('.')
    while (parts.length > 0) {
      const source = byClass.get(parts.join('.'))
      if (source) return source
      parts.pop()
    }
    return undefined
  }
  const observations: TiaDependencyObservation[] = []
  for (const suite of options.suites) {
    const imported = new Set<string>()
    const pending = [...(testsByFile.get(suite.file)?.imports ?? [])]
    while (pending.length > 0) {
      const name = pending.pop()
      if (!name) continue
      const source = importedSource(name)
      if (source && !imported.has(source.file)) {
        imported.add(source.file)
        pending.push(...source.imports)
      }
    }
    observations.push({
      confidence: 'exact',
      kind: 'configuration',
      source: suite.file,
      suiteId: suite.id,
    })
    for (const source of [...imported].sort(byCodeUnit)) {
      observations.push({
        confidence: 'inferred',
        kind: 'import',
        source,
        suiteId: suite.id,
      })
    }
  }
  return externalGraph({
    environmentFingerprint: options.environmentFingerprint,
    fingerprint: options.fingerprint ?? catalogFingerprint(options.suites),
    invalidators: [...GRADLE_INVALIDATORS, ...(options.invalidators ?? [])],
    knownSources: [
      ...new Set([
        ...sources.map((source) => source.file),
        ...options.suites.map((suite) => suite.file),
      ]),
    ].sort(byCodeUnit),
    observations,
    suites: options.suites.map(({ className: _, ...suite }) => suite),
  })
})

export const planSuites = (suites: GradleSuite[], options: PlanGradleOptions) =>
  planExternal('gradle-junit', suites, options)

function asList(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function xmlCases(suite: unknown): unknown[] {
  if (!isRecord(suite)) return []
  return [
    ...asList(suite['testcase']),
    ...asList(suite['testsuite']).flatMap(xmlCases),
  ]
}

function junitCase(value: unknown): JUnitCase {
  const element = isRecord(value) ? value : {}
  const className = element['classname']
  const name = element['name']
  const time = element['time']
  return {
    className: typeof className === 'string' ? className : '',
    ...(time === undefined ? {} : { durationSeconds: Number(time) }),
    name: typeof name === 'string' ? name : '',
    status:
      element['failure'] !== undefined || element['error'] !== undefined
        ? 'failed'
        : element['skipped'] !== undefined
          ? 'skipped'
          : 'passed',
  }
}

const xmlParser = new XMLParser({
  allowBooleanAttributes: true,
  attributeNamePrefix: '',
  ignoreAttributes: false,
})

export function parseJUnitReport(xml: string): JUnitCase[] {
  const parsed: unknown = xmlParser.parse(xml)
  const document = isRecord(parsed) ? parsed : {}
  const root = document['testsuites'] ?? document['testsuite'] ?? {}
  return xmlCases(root).map(junitCase)
}

export const readReports = Effect.fnUntraced(function* (
  rootValue: string,
  patterns: readonly string[],
  notBefore: Date | undefined,
) {
  const fs = yield* FileSystem.FileSystem
  const root = resolve(rootValue)
  const paths = yield* globFiles(patterns, { cwd: root })
  const reports = yield* Effect.forEach(
    paths.sort(),
    (path) =>
      Effect.gen(function* () {
        if (notBefore !== undefined) {
          const info = yield* fs.stat(path).pipe(Effect.mapError(ioFailure))
          const modified = Option.getOrUndefined(info.mtime)
          if (modified === undefined || modified < notBefore) return []
        }
        const xml = yield* fs
          .readFileString(path)
          .pipe(Effect.mapError(ioFailure))
        return yield* attempt(() => parseJUnitReport(xml))
      }),
    { concurrency: 16 },
  )
  return reports.flat()
})

const executable = Effect.fnUntraced(function* (
  root: string,
  configured: string | undefined,
) {
  if (configured) return configured
  const fs = yield* FileSystem.FileSystem
  const candidate = resolve(
    root,
    process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
  )
  yield* fs.access(candidate).pipe(Effect.mapError(ioFailure))
  return candidate
})

/**
 * A file created just before Gradle starts. Result XML older than it comes
 * from an earlier run and must not satisfy this run's completeness check.
 */
const runMarker = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true })
  const marker = yield* fs.makeTempFileScoped({
    directory,
    prefix: 'gradle-run-',
  })
  const info = yield* fs.stat(marker)
  return Option.getOrUndefined(info.mtime)
})

/**
 * How each selected class ended, from the JUnit cases of the run: failed when
 * a case failed, passed when it reported cases that all held, and unknown when
 * it reported none.
 */
function classOutcomes(
  selected: readonly GradleSuite[],
  cases: readonly JUnitCase[],
): Record<string, TiaSuiteOutcome> {
  return Object.fromEntries(
    selected.map((suite): [string, TiaSuiteOutcome] => {
      const own = cases.filter((item) => item.className === suite.className)
      return [
        suite.id,
        own.length === 0
          ? 'unknown'
          : own.some((item) => item.status === 'failed')
            ? 'failed'
            : 'passed',
      ]
    }),
  )
}

export const run = Effect.fn('tia.gradle.run')(function* (
  options: TiaGradleOptions,
) {
  const verification = yield* verificationTarget(process.env)
  const root = resolve(options.root)
  const graphPath = resolve(root, options.graphPath ?? '.tia/gradle/graph.json')
  const graph =
    options.graph === undefined
      ? yield* readAdapterGraph(graphPath)
      : options.graph
  const suites = yield* discover(options)
  const plan = yield* planSuites(suites, { ...withFresh(options), graph })
  const selected = new Set(plan.selected)
  const chosen = suites.filter((suite) => selected.has(suite.id))
  const classes = chosen.map((suite) => suite.className)
  const recordGraph = createGraph(root, {
    environmentFingerprint: options.currentEnvironmentFingerprint,
    ...(options.currentFingerprint === undefined
      ? {}
      : { fingerprint: options.currentFingerprint }),
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    suites,
  })
  const verify = (
    recorded: TiaImpactGraph,
    junit: readonly JUnitCase[],
    success: boolean,
  ) =>
    writeProtocolVerificationSnapshot({
      executed: chosen.map((suite) => suite.id),
      graph: recorded,
      outcomes: classOutcomes(chosen, junit),
      plan,
      runner: verificationRunnerName('gradle', root, graphPath),
      success,
      target: verification,
    })
  if (classes.length === 0) {
    if (verification !== undefined) yield* verify(yield* recordGraph, [], true)
    return { cases: [], plan, status: 0, success: true }
  }
  const command = yield* executable(root, options.command)
  const reportPatterns = options.reports ?? DEFAULT_REPORTS
  const { cases, forOutcomes, status } = yield* Effect.scoped(
    Effect.gen(function* () {
      const started = yield* runMarker(dirname(graphPath)).pipe(
        Effect.orElseSucceed(() => new Date()),
      )
      const exit = yield* runAttached({
        args: [
          ...(options.commandArguments ?? []),
          options.task ?? 'test',
          ...classes.flatMap((className) => ['--tests', className]),
        ],
        command,
        cwd: root,
        env: inheritedEnvironment(options.environment),
      })
      const reported =
        exit === 0 ? yield* readReports(root, reportPatterns, started) : []
      // A failing run reports no cases, but a verification still wants to
      // know which classes failed.
      const attributable =
        exit !== 0 && verification !== undefined
          ? yield* readReports(root, reportPatterns, started).pipe(
              Effect.orElseSucceed((): JUnitCase[] => []),
            )
          : reported
      return { cases: reported, forOutcomes: attributable, status: exit }
    }),
  )
  const reportedClasses = new Set(cases.map((testCase) => testCase.className))
  const missingReports =
    (options.requireReports ?? true) &&
    classes.some((className) => !reportedClasses.has(className))
  const failedCases = cases.some((testCase) => testCase.status === 'failed')
  const finalStatus =
    status === 0 && (missingReports || failedCases) ? 1 : status
  // A failed run promotes no graph, but a verification still compares the one
  // it would have recorded.
  if (finalStatus === 0 || verification !== undefined) {
    const recorded = yield* recordGraph
    if (finalStatus === 0) yield* writeAdapterGraph(graphPath, recorded)
    yield* verify(recorded, forOutcomes, finalStatus === 0)
  }
  return { cases, plan, status: finalStatus, success: finalStatus === 0 }
})
