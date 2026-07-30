import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'

import { init, parse } from 'es-module-lexer'
import { glob } from 'tinyglobby'

import { createImpactPlan } from '../core/impact.js'
import { normalizeProtocolPath } from '../protocol/paths.js'
import {
  TIA_PROTOCOL_VERSION,
  type TiaDependencyObservation,
  type TiaImpactGraph,
  type TiaImpactPlan,
  type TiaInvalidator,
  type TiaSuiteDescriptor,
} from '../protocol/types.js'

export interface K6Suite extends TiaSuiteDescriptor {
  profile: string
}

export interface DiscoverK6Options {
  profiles: string
  project: string
  root: string
}

export interface K6GraphOptions {
  environmentFingerprint: string
  fingerprint?: string
  invalidators?: TiaInvalidator[]
  knownSources?: string[]
  observations?: TiaDependencyObservation[]
  suites: K6Suite[]
}

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.ts'] as const

async function existingImportPath(
  importer: string,
  specifier: string,
): Promise<string | null> {
  if (!specifier.startsWith('.')) return null
  const unresolved = resolve(dirname(importer), specifier)
  const candidates =
    extname(unresolved) === ''
      ? SCRIPT_EXTENSIONS.map((extension) => `${unresolved}${extension}`)
      : [unresolved]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  return null
}

async function localImports(
  root: string,
  entry: string,
): Promise<string[]> {
  await init
  const visited = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined || visited.has(path)) continue
    visited.add(path)
    const source = await readFile(path, 'utf8')
    const [imports] = parse(source)
    for (const imported of imports) {
      if (imported.n === undefined) continue
      const resolved = await existingImportPath(path, imported.n)
      if (resolved === null) continue
      const projectFile = normalizeProtocolPath(relative(root, resolved))
      const absolute = resolve(root, projectFile)
      if (!visited.has(absolute)) pending.push(absolute)
    }
  }
  return [...visited]
    .map((path) => normalizeProtocolPath(relative(root, path)))
    .sort()
}

function suiteId(project: string, file: string): string {
  return `k6:${project}:${file}`
}

function protocolSuite(suite: K6Suite): TiaSuiteDescriptor {
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

export async function discoverK6Suites(
  options: DiscoverK6Options,
): Promise<K6Suite[]> {
  const root = resolve(options.root)
  const profileRoot = resolve(root, options.profiles)
  const paths = await glob(['*.js', '*.mjs', '*.ts'], {
    absolute: true,
    cwd: profileRoot,
    onlyFiles: true,
  })
  return paths
    .sort()
    .map((path) => {
      const file = normalizeProtocolPath(relative(root, path))
      return {
        adapter: 'k6',
        file,
        id: suiteId(options.project, file),
        profile: file.replace(/^.*\//u, '').replace(/\.[^.]+$/u, ''),
        project: options.project,
        resourceLocks: ['performance-host'],
      }
    })
}

export async function k6CatalogFingerprint(
  suites: readonly K6Suite[],
): Promise<string> {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...suites].sort((left, right) => left.id.localeCompare(right.id)),
      ),
    )
    .digest('hex')
}

export async function createK6Graph(
  root: string,
  options: K6GraphOptions,
): Promise<TiaImpactGraph> {
  const observations: TiaDependencyObservation[] = []
  for (const suite of options.suites) {
    const imports = await localImports(resolve(root), resolve(root, suite.file))
    for (const source of imports) {
      observations.push({
        confidence: 'exact',
        kind: source === suite.file ? 'configuration' : 'import',
        source,
        suiteId: suite.id,
      })
    }
  }
  return {
    complete: true,
    environmentFingerprint: options.environmentFingerprint,
    fingerprint:
      options.fingerprint ?? (await k6CatalogFingerprint(options.suites)),
    invalidators: options.invalidators ?? [],
    knownSources: options.knownSources ?? [],
    observations: [...observations, ...(options.observations ?? [])],
    protocolVersion: TIA_PROTOCOL_VERSION,
    suites: options.suites.map(protocolSuite),
  }
}

export interface PlanK6Options extends DiscoverK6Options {
  allowedProfiles?: string[]
  changes: string[]
  currentEnvironmentFingerprint: string
  currentFingerprint?: string
  forceFull?: boolean
  graph: TiaImpactGraph | null
  ignoreChanges?: string[]
  onUnknownChange?: 'full' | 'ignore'
}

export async function planK6(
  options: PlanK6Options,
): Promise<TiaImpactPlan> {
  const suites = await discoverK6Suites(options)
  const allowed =
    options.allowedProfiles === undefined
      ? undefined
      : suites
          .filter((suite) => options.allowedProfiles?.includes(suite.profile))
          .map((suite) => suite.id)
  if (
    options.allowedProfiles !== undefined &&
    allowed?.length !== new Set(options.allowedProfiles).size
  ) {
    throw new Error('k6 policy names an unknown or duplicate profile')
  }
  return createImpactPlan({
    catalog: suites,
    changes: { files: options.changes, provider: 'k6' },
    currentEnvironmentFingerprint: options.currentEnvironmentFingerprint,
    currentFingerprint:
      options.currentFingerprint ?? (await k6CatalogFingerprint(suites)),
    graph: options.graph,
    policy: {
      ...(allowed === undefined ? {} : { allowedSuites: allowed }),
      forceFull: options.forceFull ?? false,
      ignoreChanges: options.ignoreChanges ?? [],
      onUnknownChange: options.onUnknownChange ?? 'full',
    },
  })
}
