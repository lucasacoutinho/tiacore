import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'
import { glob } from 'tinyglobby'

import {
  readAdapterGraph,
  writeAdapterGraph,
} from '../../engine/scheduling/external.js'
import { normalizeProtocolPath } from '../../protocol/paths.js'
import { createImpactPlan } from '../../protocol/planner.js'
import {
  TIA_PROTOCOL_VERSION,
  type TiaImpactGraph,
  type TiaImpactPlan,
  type TiaInvalidator,
  type TiaSuiteDescriptor,
} from '../../protocol/types.js'

const DEFAULT_TESTS = [
  '**/src/test/**/*.{java,kt}',
  '**/src/androidTest/**/*.{java,kt}',
]
const DEFAULT_SOURCES = ['**/src/main/**/*.{java,kt}']
const DEFAULT_REPORTS = ['**/build/test-results/**/*.xml']
const GRADLE_INVALIDATORS: TiaInvalidator[] = [
  { pattern: '**/*.gradle', reason: 'Gradle build configuration changed' },
  { pattern: '**/*.gradle.kts', reason: 'Gradle build configuration changed' },
  { pattern: '**/gradle.properties', reason: 'Gradle properties changed' },
  { pattern: '**/settings.gradle', reason: 'Gradle settings changed' },
  { pattern: '**/settings.gradle.kts', reason: 'Gradle settings changed' },
]

export interface GradleSuite extends TiaSuiteDescriptor {
  className: string
}

export interface DiscoverGradleOptions {
  project: string
  root: string
  sources?: string[]
  tests?: string[]
}

export interface GradleGraphOptions {
  environmentFingerprint: string
  fingerprint?: string
  invalidators?: TiaInvalidator[]
  sources?: string[]
  suites: GradleSuite[]
}

interface SourceDescriptor {
  className: string
  file: string
  imports: string[]
}

export interface JUnitCase {
  className: string
  durationSeconds?: number
  name: string
  status: 'failed' | 'passed' | 'skipped'
}

function array<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function descriptor(file: string, source: string): SourceDescriptor {
  const packageName = /^\s*package\s+([A-Za-z_][\w.]*)/mu.exec(source)?.[1]
  const declaredName =
    /^\s*(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|enum|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/mu.exec(source)?.[1]
    ?? basename(file, extname(file))
  return {
    className: packageName ? `${packageName}.${declaredName}` : declaredName,
    file,
    imports: [...source.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.*]*)/gmu)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined),
  }
}

async function sourceDescriptors(
  root: string,
  patterns: readonly string[],
): Promise<SourceDescriptor[]> {
  const files = await glob(patterns, {
    absolute: true,
    cwd: root,
    ignore: ['**/build/**', '**/node_modules/**'],
    onlyFiles: true,
  })
  return Promise.all(
    files.sort().map(async (absolute) =>
      descriptor(
        normalizeProtocolPath(relative(root, absolute)),
        await readFile(absolute, 'utf8'),
      ),
    ),
  )
}

function suiteId(project: string, file: string): string {
  return `gradle-junit:${project}:${file}`
}

export async function discoverGradleSuites(
  options: DiscoverGradleOptions,
): Promise<GradleSuite[]> {
  const root = resolve(options.root)
  return (await sourceDescriptors(root, options.tests ?? DEFAULT_TESTS))
    .map((test) => ({
      adapter: 'gradle-junit',
      className: test.className,
      file: test.file,
      id: suiteId(options.project, test.file),
      project: options.project,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function gradleCatalogFingerprint(
  suites: readonly GradleSuite[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([...suites].sort((a, b) => a.id.localeCompare(b.id))))
    .digest('hex')
}

export async function createGradleGraph(
  rootValue: string,
  options: GradleGraphOptions,
): Promise<TiaImpactGraph> {
  const root = resolve(rootValue)
  const tests = await sourceDescriptors(
    root,
    options.suites.map((suite) => suite.file),
  )
  const sources = await sourceDescriptors(root, options.sources ?? DEFAULT_SOURCES)
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
  const observations = options.suites.flatMap((suite) => {
    const test = tests.find((candidate) => candidate.file === suite.file)
    const imported = new Set<string>()
    const pending = [...(test?.imports ?? [])]
    while (pending.length > 0) {
      const name = pending.pop()
      if (!name) continue
      const source = importedSource(name)
      if (source && !imported.has(source.file)) {
        imported.add(source.file)
        pending.push(...source.imports)
      }
    }
    return [
      {
        confidence: 'exact' as const,
        kind: 'configuration' as const,
        source: suite.file,
        suiteId: suite.id,
      },
      ...[...imported].sort().map((source) => ({
        confidence: 'inferred' as const,
        kind: 'import' as const,
        source,
        suiteId: suite.id,
      })),
    ]
  })
  return {
    complete: true,
    environmentFingerprint: options.environmentFingerprint,
    fingerprint: options.fingerprint ?? gradleCatalogFingerprint(options.suites),
    invalidators: [...GRADLE_INVALIDATORS, ...(options.invalidators ?? [])],
    knownSources: [...new Set([
      ...sources.map((source) => source.file),
      ...options.suites.map((suite) => suite.file),
    ])].sort(),
    observations,
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites: options.suites.map(({ className: _, ...suite }) => suite),
  }
}

export interface PlanGradleOptions extends DiscoverGradleOptions {
  changes: string[]
  currentEnvironmentFingerprint: string
  currentFingerprint?: string
  forceFull?: boolean
  graph: TiaImpactGraph | null
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

export async function planGradle(
  options: PlanGradleOptions,
): Promise<TiaImpactPlan> {
  const suites = await discoverGradleSuites(options)
  return createImpactPlan({
    catalog: suites,
    changes: { files: options.changes, provider: 'gradle-junit' },
    currentEnvironmentFingerprint: options.currentEnvironmentFingerprint,
    currentFingerprint:
      options.currentFingerprint ?? gradleCatalogFingerprint(suites),
    graph: options.graph,
    policy: {
      forceFull: options.forceFull ?? false,
      ignoreChanges: options.ignoreChanges ?? [],
      onUnknownChange: options.onUnknownChange ?? 'full',
    },
  })
}

interface XmlCase {
  classname?: string
  error?: unknown
  failure?: unknown
  name?: string
  skipped?: unknown
  time?: number | string
}

interface XmlSuite {
  testcase?: XmlCase | XmlCase[]
  testsuite?: XmlSuite | XmlSuite[]
}

function xmlCases(suite: XmlSuite): XmlCase[] {
  return [
    ...array(suite.testcase),
    ...array(suite.testsuite).flatMap(xmlCases),
  ]
}

export function parseJUnitReport(xml: string): JUnitCase[] {
  const parsed = new XMLParser({
    allowBooleanAttributes: true,
    attributeNamePrefix: '',
    ignoreAttributes: false,
  }).parse(xml) as { testsuite?: XmlSuite; testsuites?: XmlSuite }
  const root = parsed.testsuites ?? parsed.testsuite ?? {}
  return xmlCases(root).map((testCase) => ({
    className: testCase.classname ?? '',
    ...(testCase.time === undefined
      ? {}
      : { durationSeconds: Number(testCase.time) }),
    name: testCase.name ?? '',
    status:
      testCase.failure !== undefined || testCase.error !== undefined
        ? 'failed'
        : testCase.skipped !== undefined
          ? 'skipped'
          : 'passed',
  }))
}

export async function readJUnitReports(
  rootValue: string,
  patterns: readonly string[] = DEFAULT_REPORTS,
): Promise<JUnitCase[]> {
  const root = resolve(rootValue)
  const paths = await glob(patterns, { absolute: true, cwd: root, onlyFiles: true })
  return (await Promise.all(paths.sort().map(async (path) =>
    parseJUnitReport(await readFile(path, 'utf8')),
  ))).flat()
}

export interface TiaGradleOptions extends Omit<PlanGradleOptions, 'graph'> {
  command?: string
  commandArguments?: string[]
  environment?: NodeJS.ProcessEnv
  graph?: TiaImpactGraph | null
  graphPath?: string
  reports?: string[]
  requireReports?: boolean
  task?: string
}

export interface TiaGradleResult {
  cases: JUnitCase[]
  plan: TiaImpactPlan
  status: number
  success: boolean
}

async function executable(root: string, configured?: string): Promise<string> {
  if (configured) return configured
  const candidate = resolve(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
  await access(candidate)
  return candidate
}

async function runGradle(
  command: string,
  arguments_: string[],
  root: string,
  environment?: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      resolveStatus(code ?? (signal === null ? 1 : 128)),
    )
  })
}

export class TiaGradleRunner {
  constructor(private readonly options: TiaGradleOptions) {}

  async run(): Promise<TiaGradleResult> {
    const root = resolve(this.options.root)
    const graphPath = resolve(root, this.options.graphPath ?? '.tia/gradle/graph.json')
    const graph = this.options.graph === undefined
      ? await readAdapterGraph(graphPath)
      : this.options.graph
    const suites = await discoverGradleSuites(this.options)
    const plan = await planGradle({ ...this.options, graph })
    const selected = new Set(plan.selected)
    const classes = suites
      .filter((suite) => selected.has(suite.id))
      .map((suite) => suite.className)
    if (classes.length === 0) {
      return { cases: [], plan, status: 0, success: true }
    }
    const status = await runGradle(
      await executable(root, this.options.command),
      [
        ...(this.options.commandArguments ?? []),
        this.options.task ?? 'test',
        ...classes.flatMap((className) => ['--tests', className]),
      ],
      root,
      this.options.environment,
    )
    const cases = status === 0
      ? await readJUnitReports(root, this.options.reports ?? DEFAULT_REPORTS)
      : []
    const observed = new Set(cases.map((testCase) => testCase.className))
    const missingReports =
      (this.options.requireReports ?? true) &&
      classes.some((className) => !observed.has(className))
    const failedCases = cases.some((testCase) => testCase.status === 'failed')
    const finalStatus =
      status === 0 && (missingReports || failedCases) ? 1 : status
    if (finalStatus === 0) {
      await writeAdapterGraph(graphPath, await createGradleGraph(root, {
        environmentFingerprint: this.options.currentEnvironmentFingerprint,
        ...(this.options.currentFingerprint === undefined
          ? {}
          : { fingerprint: this.options.currentFingerprint }),
        ...(this.options.sources === undefined
          ? {}
          : { sources: this.options.sources }),
        suites,
      }))
    }
    return {
      cases,
      plan,
      status: finalStatus,
      success: finalStatus === 0,
    }
  }
}

export function tia(options: TiaGradleOptions): TiaGradleRunner {
  return new TiaGradleRunner(options)
}
