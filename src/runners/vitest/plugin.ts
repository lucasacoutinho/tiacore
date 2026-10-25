/// <reference types="vitest/config" />

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as Effect from 'effect/Effect'
import { createInstrumenter } from 'istanbul-lib-instrument'
import type { Plugin } from 'vite'

import { VERSION } from '../../core/version.ts'
import { runPromise } from '../../host/runtime.ts'
import { projectFingerprint } from '../../engine/baseline/fingerprint.ts'
import { CoverageTemplates } from '../../engine/coverage/templates.ts'
import { globMatcher } from '../../engine/glob.ts'
import {
  isInside,
  projectRelative,
  resolveCacheDir,
  slash,
} from '../../engine/host-path.ts'
import { EngineLive } from '../../engine/layers.ts'
import { artifactRestore } from '../../engine/artifacts/restore-step.ts'
import { beginRun, snapshotProject } from '../../engine/lifecycle.ts'
import {
  partitionCacheDir,
  partitionGroup,
} from '../../engine/state/partitions.ts'
import { verificationTarget } from '../../engine/verification-snapshot.ts'
import {
  coverageRuntime,
  hasNativeSelection,
  normalizeOptions,
  type TiaOptions,
} from './options.ts'
import { TIA_SELECTION_KEY, type TiaTestSelection } from './protocol.ts'
import { TiaReporter } from './reporter.ts'
import { initialRuntime, type TiaRuntime } from './state.ts'
import { errorMessage } from '../../wire/errors.ts'

interface SharedPluginState {
  bypassed: boolean
  excludeMatcher: ((path: string) => boolean) | null
  includeMatcher: ((path: string) => boolean) | null
  initialized: boolean
  runtime: TiaRuntime
  selectedProjects: Set<object>
}

// Process-wide registries: Vitest builds one plugin instance per project and
// may load this module more than once, so state is keyed on Symbol.for.
function registry<T>(name: string, create: () => T): T {
  const key = Symbol.for(`tiacore@${VERSION}/${name}`)
  const holder = globalThis as typeof globalThis & Record<symbol, T | undefined>
  holder[key] ??= create()
  return holder[key]
}

const sharedStates = registry(
  'shared-state',
  () => new WeakMap<object, SharedPluginState>(),
)
const runtimeStates = registry(
  'browser-runtime-state',
  () => new Map<string, TiaRuntime>(),
)
const reporterRuntimes = registry(
  'reporter-runtime-state',
  () => new WeakSet<TiaRuntime>(),
)

function normalizeSetupFiles(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === 'string')
  return []
}

function impossibleTestPattern(cacheDir: string): string {
  return slash(
    resolve(cacheDir, '__no_affected_tests__', '**', '*.{test,spec}.ts'),
  )
}

function setupProxyPath(root: string, cacheDir: string): string {
  const resolvedCache = resolveCacheDir(root, cacheDir)
  const localCache = isInside(root, resolvedCache)
    ? resolvedCache
    : resolve(root, '.tia')
  return resolve(localCache, 'runtime', `setup-${VERSION}.mjs`)
}

/** The worker setup module: the built `vitest-setup.js`, or the source in development. */
function pluginSetupPath(): string {
  const candidates = [
    new URL('./vitest-setup.js', import.meta.url),
    new URL('../vitest-setup.js', import.meta.url),
    new URL('./setup.ts', import.meta.url),
  ].map((url) => fileURLToPath(url))
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? ''
  )
}

function ensureSetupProxy(
  root: string,
  cacheDir: string,
  setupPath: string,
): string {
  const proxyPath = setupProxyPath(root, cacheDir)
  const contents = `import ${JSON.stringify(pathToFileURL(setupPath).href)}\n`
  if (!existsSync(proxyPath) || readFileSync(proxyPath, 'utf8') !== contents) {
    mkdirSync(dirname(proxyPath), { recursive: true })
    writeFileSync(proxyPath, contents)
  }
  return proxyPath
}

function affectedTestsForProject(
  affectedTests: readonly string[],
  globalRoot: string,
  projectRoot: string,
  include: readonly string[],
  exclude: readonly string[],
): string[] {
  const includes = globMatcher(include)
  const excludes = globMatcher(exclude)
  return affectedTests
    .map((file) => {
      const absolute = resolve(globalRoot, file)
      return {
        absolute: slash(absolute),
        projectRelative: slash(relative(projectRoot, absolute)),
        rootRelative: file,
      }
    })
    .filter(
      (file) =>
        !file.projectRelative.startsWith('../') &&
        (includes(file.projectRelative) ||
          includes(file.rootRelative) ||
          includes(file.absolute)) &&
        !(
          excludes(file.projectRelative) ||
          excludes(file.rootRelative) ||
          excludes(file.absolute)
        ),
    )
    .map((file) => file.projectRelative)
}

export interface TiaPlugin {
  name: string
}

/** The tiacore Vitest plugin: selects the tests a change affects and replays the rest. */
export function tia(options?: TiaOptions): TiaPlugin
export function tia(options: TiaOptions = {}): Plugin {
  const normalized = normalizeOptions(options)
  const setupPath = pluginSetupPath()
  let runtime = initialRuntime(normalized, process.cwd())
  let includeMatcher: ((path: string) => boolean) | null = null
  let excludeMatcher: ((path: string) => boolean) | null = null

  return {
    name: 'tiacore',
    enforce: 'post',

    config(config) {
      if (!normalized.enabled) return
      const root = resolve(config.root ?? process.cwd())
      const runtimeKey = `${slash(root)}\0${slash(resolveCacheDir(root, normalized.cacheDir))}`
      const existing = runtimeStates.get(runtimeKey)
      if (existing === undefined) runtimeStates.set(runtimeKey, runtime)
      else runtime = existing
      const setupProxy = ensureSetupProxy(root, normalized.cacheDir, setupPath)
      config.test ??= {}
      // Vitest 5 enables both by default. A cached transform skips tiacore's
      // instrumentation, and a shared Vite server skips this hook for inline
      // projects. Vitest 4 ignores the unknown keys.
      if (!('fsModuleCache' in config.test))
        Object.assign(config.test, { fsModuleCache: false })
      if (!('sharedViteServer' in config.test))
        Object.assign(config.test, { sharedViteServer: false })
      const setupFiles = normalizeSetupFiles(config.test.setupFiles)
      if (!setupFiles.includes(setupProxy))
        config.test.setupFiles = [...setupFiles, setupProxy]
    },

    async configureVitest({ project, vitest }) {
      if (!normalized.enabled) return
      let shared = sharedStates.get(vitest)
      if (shared === undefined) {
        shared = {
          bypassed: false,
          excludeMatcher: null,
          includeMatcher: null,
          initialized: false,
          runtime,
          selectedProjects: new Set<object>(),
        }
        sharedStates.set(vitest, shared)
      } else {
        runtime = shared.runtime
        includeMatcher = shared.includeMatcher
        excludeMatcher = shared.excludeMatcher
      }
      if (shared.bypassed) return

      const candidates = [...new Set([...vitest.projects, project])]
      const hooks = vitest.config.sequence.hooks
      const selectAll: TiaTestSelection = {
        hooks,
        mode: 'all',
        testIds: [],
        wholeTestFiles: [],
      }
      const nativeCoverageProject = candidates.find(
        (candidate) => candidate.config.coverage.enabled,
      )

      if (
        vitest.config.watch ||
        hasNativeSelection(
          resolve(vitest.config.root ?? process.cwd()),
          vitest.config,
        )
      ) {
        for (const candidate of candidates)
          candidate.provide(TIA_SELECTION_KEY, selectAll)
        runtime.active = false
        shared.bypassed = true
        return
      }

      if (!shared.initialized) {
        const current = runtime
        // The runtime outlives a Vitest instance, and so would the templates
        // of every file version this process ever transformed. This run
        // registers the ones it needs as it transforms.
        current.coverageTemplates = new CoverageTemplates()
        current.root = resolve(vitest.config.root)
        current.options = {
          ...normalized,
          cacheDir: resolveCacheDir(current.root, normalized.cacheDir),
        }
        current.coverage = coverageRuntime(
          current.root,
          normalized.coverage,
          nativeCoverageProject?.config.coverage ?? null,
        )
        if (nativeCoverageProject !== undefined) vitest.disableCoverage()

        const cachePrefix =
          projectRelative(current.root, current.options.cacheDir) ?? ''
        const ignoredPrefixes = [
          cachePrefix,
          projectRelative(current.root, current.coverage.reportsDirectory),
          ...candidates.map((candidate) =>
            projectRelative(
              current.root,
              resolve(current.root, candidate.config.coverage.reportsDirectory),
            ),
          ),
        ].filter((file): file is string => file !== null && file !== '')
        current.structuralFiles = [
          ...new Set(
            candidates
              .map((candidate) => candidate.vite.config.configFile)
              .filter((file): file is string => typeof file === 'string')
              .map((file) => projectRelative(current.root, file))
              .filter((file): file is string => file !== null),
          ),
        ]

        const shard = vitest.config.shard
        current.run = await runPromise(
          Effect.gen(function* () {
            current.verification = yield* verificationTarget(process.env)
            const fingerprint = yield* projectFingerprint(
              current.root,
              current.options,
              current.structuralFiles,
            )
            const snapshot = yield* snapshotProject(
              current.root,
              ignoredPrefixes,
              fingerprint,
            )
            current.partition =
              shard === undefined
                ? null
                : {
                    group: partitionGroup(
                      snapshot.baseline,
                      fingerprint,
                      shard.count,
                      current.options.shardGroup,
                    ),
                    index: shard.index,
                    total: shard.count,
                  }
            const writeCacheDir =
              current.partition === null
                ? current.options.cacheDir
                : partitionCacheDir(current.options.cacheDir, current.partition)
            const restore = yield* artifactRestore(
              current.options.artifacts,
              current.options.log,
              current.options.artifactTrust,
            )
            return yield* beginRun({
              cacheDir: current.options.cacheDir,
              ...(restore === undefined ? {} : { restore }),
              coverageRequested: current.coverage.enabled,
              ignoredPrefixes,
              options: current.options,
              partitioned: current.partition !== null,
              root: current.root,
              snapshot,
              writeCacheDir,
            })
          }).pipe(Effect.provide(EngineLive)),
        )
        current.active = true
        shared.initialized = true

        if (!reporterRuntimes.has(current)) {
          reporterRuntimes.add(current)
          vitest.config.reporters.push(new TiaReporter(current))
        }
        includeMatcher = globMatcher(current.options.include)
        excludeMatcher = globMatcher(current.options.exclude)
        shared.includeMatcher = includeMatcher
        shared.excludeMatcher = excludeMatcher
      }

      const plan = runtime.run?.plan
      if (plan === undefined) return
      if (plan.mode === 'record') {
        for (const candidate of candidates)
          candidate.provide(TIA_SELECTION_KEY, selectAll)
        return
      }

      vitest.config.passWithNoTests = true
      const selection: TiaTestSelection = {
        hooks,
        mode: 'tests',
        testIds: plan.affectedTestIds,
        wholeTestFiles: plan.wholeTestFiles.map((file) =>
          slash(resolve(runtime.root, file)),
        ),
      }
      for (const candidate of candidates) {
        if (shared.selectedProjects.has(candidate)) continue
        shared.selectedProjects.add(candidate)
        candidate.provide(TIA_SELECTION_KEY, selection)
        const candidateConfig = candidate.config
        const affected = affectedTestsForProject(
          plan.affectedTests,
          runtime.root,
          resolve(candidateConfig.root),
          candidateConfig.include,
          candidateConfig.exclude,
        )
        candidateConfig.include =
          affected.length === 0
            ? [impossibleTestPattern(runtime.options.cacheDir)]
            : affected
        candidateConfig.passWithNoTests = true
      }
    },

    transform(code, id) {
      if (!runtime.active) return
      includeMatcher ??= globMatcher(runtime.options.include)
      excludeMatcher ??= globMatcher(runtime.options.exclude)
      const cleanId = id.split('?', 1)[0]
      if (
        cleanId === undefined ||
        cleanId.startsWith('\0') ||
        !isInside(runtime.root, cleanId)
      )
        return
      const relativeId = slash(relative(runtime.root, cleanId))
      if (!includeMatcher(relativeId) || excludeMatcher(relativeId)) return

      runtime.instrumenter ??= createInstrumenter({
        coverageVariable: '__coverage__',
        esModules: true,
        produceSourceMap: true,
      })
      try {
        const inputMap = this.getCombinedSourcemap()
        const transformed = runtime.instrumenter.instrumentSync(
          code,
          cleanId,
          inputMap.mappings === ''
            ? undefined
            : (inputMap as unknown as Parameters<
                typeof runtime.instrumenter.instrumentSync
              >[2]),
        )
        runtime.coverageTemplates.register(
          transformed,
          runtime.instrumenter.lastFileCoverage(),
        )
        return {
          code: transformed,
          map: runtime.instrumenter.lastSourceMap() as never,
        }
      } catch (error) {
        this.warn(
          `tiacore could not instrument ${relativeId}: ${errorMessage(error)}`,
        )
        return
      }
    },
  }
}
