import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  DEFAULT_CACHE_DIR,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
} from '../../core/defaults.ts'
import { envFlag, freshRequested } from '../../core/env.ts'
import type { TiaReplayAdapter, TiaReplayReporter } from '../../core/replay.ts'
import type {
  NormalizedCoverageOptions,
  TiaCoverageOptions,
  TiaCoverageReporterConfig,
  TiaCoverageReporterRuntime,
  TiaCoverageRuntime,
  TiaCoverageThresholds,
} from '../../engine/coverage/types.ts'
import {
  frameworkAdapters,
  frameworkFingerprint,
} from '../../engine/edges/index.ts'
import type {
  TiaFrameworkEdgeAdapter,
  TiaFrameworkOptions,
} from '../../engine/edges/types.ts'
import { slash } from '../../engine/host-path.ts'
import { TEST_FILE_PATTERN } from '../../engine/plan/runtime.ts'

export interface TiaOptions {
  enabled?: boolean
  cacheDir?: string
  shardGroup?: string
  include?: string[]
  exclude?: string[]
  ignoreChanges?: string[]
  fresh?: boolean
  onUnknownChange?: 'full' | 'ignore'
  log?: boolean
  coverage?: boolean | TiaCoverageOptions
  frameworks?: TiaFrameworkOptions
  replayAdapters?: TiaReplayAdapter | TiaReplayAdapter[]
  replayReporters?: TiaReplayReporter | TiaReplayReporter[]
}

export interface NormalizedOptions {
  cacheDir: string
  coverage: false | NormalizedCoverageOptions
  enabled: boolean
  exclude: string[]
  fresh: boolean
  frameworkAdapters: TiaFrameworkEdgeAdapter[]
  frameworkFingerprint: string
  ignoreChanges: string[]
  include: string[]
  log: boolean
  onUnknownChange: 'full' | 'ignore'
  replayAdapters: TiaReplayAdapter[]
  replayReporters: TiaReplayReporter[]
  shardGroup?: string
}

const DEFAULT_WATERMARKS = {
  branches: [50, 80],
  functions: [50, 80],
  lines: [50, 80],
  statements: [50, 80],
} satisfies NormalizedCoverageOptions['watermarks']

/** Enabled by `TIA`, else on CI or for `vitest run`, never in watch mode. */
export function defaultEnabled(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
): boolean {
  if (env['TIA'] !== undefined) return envFlag(env, 'TIA')
  return envFlag(env, 'CI') || argv.includes('run') || argv.includes('--run')
}

function list<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

export function normalizeOptions(
  options: TiaOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
  argv: readonly string[] = process.argv,
): NormalizedOptions {
  const requested = options.coverage === true ? {} : options.coverage || null
  const adapters = frameworkAdapters(options.frameworks)
  const shardGroup =
    options.shardGroup ??
    (env['TIA_SHARD_GROUP']?.trim() === '' ? undefined : env['TIA_SHARD_GROUP'])
  return {
    cacheDir: options.cacheDir ?? DEFAULT_CACHE_DIR,
    coverage:
      requested === null
        ? false
        : {
            clean: requested.clean ?? true,
            cleanOnRerun: requested.cleanOnRerun ?? true,
            exclude: requested.exclude ?? [],
            include: requested.include ?? null,
            reportOnFailure: requested.reportOnFailure ?? false,
            reporters: requested.reporters ?? ['text', 'html', 'json'],
            reportsDirectory: requested.reportsDirectory ?? 'coverage',
            skipFull: requested.skipFull ?? false,
            thresholds: requested.thresholds ?? null,
            watermarks: {
              branches:
                requested.watermarks?.branches ?? DEFAULT_WATERMARKS.branches,
              functions:
                requested.watermarks?.functions ?? DEFAULT_WATERMARKS.functions,
              lines: requested.watermarks?.lines ?? DEFAULT_WATERMARKS.lines,
              statements:
                requested.watermarks?.statements ??
                DEFAULT_WATERMARKS.statements,
            },
          },
    enabled: options.enabled ?? defaultEnabled(env, argv),
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
    fresh: options.fresh ?? freshRequested(env),
    frameworkAdapters: adapters,
    frameworkFingerprint: frameworkFingerprint(adapters),
    ignoreChanges: options.ignoreChanges ?? [],
    include: options.include ?? DEFAULT_INCLUDE,
    log: options.log ?? true,
    onUnknownChange: options.onUnknownChange ?? 'full',
    replayAdapters: list(options.replayAdapters),
    replayReporters: [...new Set(list(options.replayReporters))],
    ...(shardGroup === undefined ? {} : { shardGroup }),
  }
}

const DEFAULT_COVERAGE_REPORTERS: TiaCoverageReporterConfig[] = [
  'text',
  'html',
  'json',
]

export function coverageReporters(
  value: unknown,
): TiaCoverageReporterRuntime[] {
  const configured =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value
        : DEFAULT_COVERAGE_REPORTERS
  const reporters: TiaCoverageReporterRuntime[] = []
  for (const item of configured) {
    if (typeof item === 'string' && item !== '') {
      reporters.push({ name: item, options: {} })
      continue
    }
    if (!Array.isArray(item) || typeof item[0] !== 'string' || item[0] === '')
      continue
    const reporterOptions: unknown = item[1]
    reporters.push({
      name: item[0],
      options:
        reporterOptions !== null &&
        typeof reporterOptions === 'object' &&
        !Array.isArray(reporterOptions)
          ? { ...reporterOptions }
          : {},
    })
  }
  return reporters.length === 0
    ? coverageReporters(DEFAULT_COVERAGE_REPORTERS)
    : reporters
}

/** The coverage configuration of Vitest's own `coverage` block, when it is enabled. */
export interface NativeCoverage {
  clean?: boolean
  cleanOnRerun?: boolean
  exclude?: string[]
  include?: string[]
  reportOnFailure?: boolean
  reporter?: unknown
  reportsDirectory?: string
  skipFull?: boolean
  thresholds?: unknown
  watermarks?: Partial<NormalizedCoverageOptions['watermarks']>
}

function nativeThresholds(value: unknown): TiaCoverageThresholds | null {
  return value !== null && typeof value === 'object'
    ? (value as TiaCoverageThresholds)
    : null
}

/**
 * Resolves tiacore's coverage: its own `coverage` option wins, otherwise
 * Vitest's enabled coverage block is taken over (tiacore reconstructs
 * coverage from the graph, so Vitest's provider is disabled).
 */
export function coverageRuntime(
  root: string,
  configured: false | NormalizedCoverageOptions,
  native: NativeCoverage | null,
): TiaCoverageRuntime {
  if (configured === false && native === null) {
    return {
      clean: true,
      cleanOnRerun: true,
      enabled: false,
      exclude: [],
      include: null,
      reportOnFailure: false,
      reporters: [],
      reportsDirectory: resolve(root, 'coverage'),
      skipFull: false,
      thresholds: null,
      watermarks: { ...DEFAULT_WATERMARKS },
    }
  }
  const runtime: TiaCoverageRuntime =
    configured === false
      ? {
          clean: native?.clean ?? true,
          cleanOnRerun: native?.cleanOnRerun ?? true,
          enabled: true,
          exclude: native?.exclude ?? [],
          include: native?.include ?? null,
          reportOnFailure: native?.reportOnFailure ?? false,
          reporters: coverageReporters(native?.reporter),
          reportsDirectory: resolve(
            root,
            native?.reportsDirectory ?? 'coverage',
          ),
          skipFull: native?.skipFull ?? false,
          thresholds: nativeThresholds(native?.thresholds),
          watermarks: {
            branches:
              native?.watermarks?.branches ?? DEFAULT_WATERMARKS.branches,
            functions:
              native?.watermarks?.functions ?? DEFAULT_WATERMARKS.functions,
            lines: native?.watermarks?.lines ?? DEFAULT_WATERMARKS.lines,
            statements:
              native?.watermarks?.statements ?? DEFAULT_WATERMARKS.statements,
          },
        }
      : {
          clean: configured.clean,
          cleanOnRerun: configured.cleanOnRerun,
          enabled: true,
          exclude: configured.exclude,
          include: configured.include,
          reportOnFailure: configured.reportOnFailure,
          reporters: coverageReporters(configured.reporters),
          reportsDirectory: resolve(root, configured.reportsDirectory),
          skipFull: configured.skipFull,
          thresholds:
            configured.thresholds ?? nativeThresholds(native?.thresholds),
          watermarks: configured.watermarks,
        }
  if (
    runtime.reportsDirectory === resolve(root) ||
    dirname(runtime.reportsDirectory) === runtime.reportsDirectory
  ) {
    throw new Error(
      `tiacore cannot use the project or filesystem root as coverage.reportsDirectory: ${runtime.reportsDirectory}`,
    )
  }
  return runtime
}

const OPTION_VALUES = new Set(['--config', '-c', '--dir', '--root'])

/** True when the command line names test files or directories to run. */
export function hasCliFileFilter(
  root: string,
  argv: readonly string[],
): boolean {
  const args = argv.slice(2)
  return args.some((argument, index) => {
    if (argument.startsWith('-')) return false
    const previous = args[index - 1]
    if (previous !== undefined && OPTION_VALUES.has(previous)) return false
    const clean = slash(argument.replace(/:\d+$/u, ''))
    return (
      TEST_FILE_PATTERN.test(clean) ||
      (clean !== 'run' &&
        clean !== 'watch' &&
        existsSync(resolve(root, clean)) &&
        !clean.includes('.config.'))
    )
  })
}

/** The Vitest selection options that make tiacore step aside. */
export interface NativeSelection {
  changed?: boolean | string
  cliExclude?: string[]
  filters?: string[]
  project?: string[]
  related?: string[]
  tagsFilter?: string[]
  testNamePattern?: RegExp
}

/** True when the user asked Vitest to select tests itself; tiacore then runs everything it is given. */
export function hasNativeSelection(
  root: string,
  config: NativeSelection,
  argv: readonly string[] = process.argv,
): boolean {
  return (
    Boolean(config.changed) ||
    (config.cliExclude?.length ?? 0) > 0 ||
    (config.filters?.length ?? 0) > 0 ||
    (config.project?.length ?? 0) > 0 ||
    (config.related?.length ?? 0) > 0 ||
    (config.tagsFilter?.length ?? 0) > 0 ||
    config.testNamePattern !== undefined ||
    hasCliFileFilter(root, argv)
  )
}
