/// <reference types="vitest/config" />

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as Effect from 'effect/Effect'
import { ChildProcessSpawner } from 'effect/process'
import { createInstrumenter } from 'istanbul-lib-instrument'
import type { Plugin } from 'vite'
import type { TestProject, Vitest } from 'vitest/node'

import { VERSION } from '../../core/version.ts'
import { runPromise } from '../../host/runtime.ts'
import { projectFingerprint } from '../../engine/baseline/fingerprint.ts'
import { makeGit } from '../../engine/baseline/git.ts'
import { globMatcher } from '../../engine/glob.ts'
import {
  isInside,
  projectRelative,
  resolveCacheDir,
  slash,
  trackedFile,
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
  bypassNotice,
  coverageRuntime,
  hasNativeSelection,
  nativeSelectionLabels,
  normalizeOptions,
  type NormalizedOptions,
  type TiaOptions,
} from './options.ts'
import { TIA_SELECTION_KEY, type TiaTestSelection } from './protocol.ts'
import { TiaReporter } from './reporter.ts'
import { initialRuntime, type TiaRuntime } from './state.ts'
import { errorMessage } from '../../wire/errors.ts'

/** What the projects of one Vitest instance share. */
interface SharedPluginState {
  bypassed: boolean
  /** The one planning of the run; every project's hook waits for it. */
  initialization: Promise<void> | null
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

/** Each Vitest instance's state: its runtime, and with it its one reporter. */
const sharedStates = registry(
  'shared-state',
  () => new WeakMap<object, SharedPluginState>(),
)
/**
 * The runtime of the Vitest instance configured last for a project root and
 * cache directory. Vitest 4 starts a Browser Mode server after the hooks ran
 * and loads the plugin again for it. That copy never sees `configureVitest`,
 * so it finds the runtime here. Instances alive at once on one root and cache
 * directory cannot tell their browser servers apart: the last one configured
 * receives the instrumentation of all of them, and the others, missing the
 * templates of browser-only modules, commit nothing.
 */
const runtimeStates = registry(
  'browser-runtime-state',
  () => new Map<string, TiaRuntime>(),
)

function runtimeKey(root: string, cacheDir: string): string {
  return `${slash(root)}\0${slash(resolveCacheDir(root, cacheDir))}`
}

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
  const directory = dirname(proxyPath)
  if (!existsSync(proxyPath) || readFileSync(proxyPath, 'utf8') !== contents) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(proxyPath, contents)
  }
  for (const name of readdirSync(directory)) {
    if (!name.startsWith('setup-') || !name.endsWith('.mjs')) continue
    const stale = resolve(directory, name)
    if (stale !== proxyPath) unlinkSync(stale)
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

/**
 * A `**` glob does not match a `..` segment, so a file outside the Vitest
 * root is also matched on its repository-relative path.
 */
export function instrumentationName(
  root: string,
  repositoryRoot: string,
  file: string,
  include: (path: string) => boolean,
  exclude: (path: string) => boolean,
): string | null {
  const rootRelative = trackedFile(root, file, repositoryRoot)
  if (rootRelative === null) return null
  if (isInside(root, file)) {
    return include(rootRelative) && !exclude(rootRelative) ? rootRelative : null
  }
  const repositoryRelative = trackedFile(repositoryRoot, file, repositoryRoot)
  if (repositoryRelative === null) return null
  const included = include(repositoryRelative) || include(rootRelative)
  const excluded = exclude(repositoryRelative) || exclude(rootRelative)
  return included && !excluded ? rootRelative : null
}

/**
 * Plans the instance's run once: reads the stored graph, decides what runs and
 * adds the instance's reporter. Vitest starts the `configureVitest` hook of
 * every project at once, so the projects of one instance wait for this single
 * planning instead of each starting their own.
 */
async function planInstance(
  current: TiaRuntime,
  normalized: NormalizedOptions,
  vitest: Vitest,
  candidates: readonly TestProject[],
): Promise<void> {
  const nativeCoverageProject = candidates.find(
    (candidate) => candidate.config.coverage.enabled,
  )
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
      const top = yield* makeGit(
        yield* ChildProcessSpawner.ChildProcessSpawner,
      ).repositoryTop(current.root)
      current.repositoryRoot =
        top !== null && isInside(top, current.root) ? top : current.root
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
  vitest.config.reporters.push(new TiaReporter(current))
}

export interface TiaPlugin {
  name: string
}

/** The tiacore Vitest plugin: selects the tests a change affects and replays the rest. */
export function tia(options?: TiaOptions): TiaPlugin
export function tia(options: TiaOptions = {}): Plugin {
  const normalized = normalizeOptions(options)
  const setupPath = pluginSetupPath()
  // The runtime of the Vitest instance that configured this plugin; until
  // then an inactive placeholder.
  let runtime = initialRuntime(normalized, process.cwd())
  let configured = false
  let key: string | null = null

  /**
   * The runtime to transform with: the configuring instance's own, or, for a
   * copy no instance configured, the one registered for its project.
   */
  const currentRuntime = (): TiaRuntime =>
    configured || key === null ? runtime : (runtimeStates.get(key) ?? runtime)

  return {
    name: 'tiacore',
    enforce: 'post',

    config(config) {
      if (!normalized.enabled) return
      const root = resolve(config.root ?? process.cwd())
      key = runtimeKey(root, normalized.cacheDir)
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
          initialization: null,
          runtime: initialRuntime(
            normalized,
            resolve(vitest.config.root ?? process.cwd()),
          ),
          selectedProjects: new Set<object>(),
        }
        sharedStates.set(vitest, shared)
      }
      runtime = shared.runtime
      configured = true
      runtimeStates.set(
        runtimeKey(resolve(project.config.root), normalized.cacheDir),
        runtime,
      )
      if (shared.bypassed) return

      const candidates = [...new Set([...vitest.projects, project])]
      const hooks = vitest.config.sequence.hooks
      const selectAll: TiaTestSelection = {
        hooks,
        mode: 'all',
        testIds: [],
        wholeTestFiles: [],
      }

      const root = resolve(vitest.config.root ?? process.cwd())
      const labels = nativeSelectionLabels(root, vitest.config)
      if (vitest.config.watch || hasNativeSelection(root, vitest.config)) {
        for (const candidate of candidates)
          candidate.provide(TIA_SELECTION_KEY, selectAll)
        runtime.active = false
        shared.bypassed = true
        if (runtime.options.log)
          vitest.logger.log(`\n ${bypassNotice(vitest.config.watch, labels)}`)
        return
      }

      shared.initialization ??= planInstance(
        runtime,
        normalized,
        vitest,
        candidates,
      )
      await shared.initialization

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
      const current = currentRuntime()
      if (!current.active) return
      const matchers = (current.matchers ??= {
        exclude: globMatcher(current.options.exclude),
        include: globMatcher(current.options.include),
      })
      const cleanId = id.split('?', 1)[0]
      if (cleanId === undefined || cleanId.startsWith('\0')) return
      const relativeId = instrumentationName(
        current.root,
        current.repositoryRoot,
        cleanId,
        matchers.include,
        matchers.exclude,
      )
      if (relativeId === null) return

      const instrumenter = (current.instrumenter ??= createInstrumenter({
        coverageVariable: '__coverage__',
        esModules: true,
        produceSourceMap: true,
      }))
      try {
        const inputMap = this.getCombinedSourcemap()
        const transformed = instrumenter.instrumentSync(
          code,
          cleanId,
          inputMap.mappings === ''
            ? undefined
            : (inputMap as unknown as Parameters<
                typeof instrumenter.instrumentSync
              >[2]),
        )
        current.coverageTemplates.register(
          transformed,
          instrumenter.lastFileCoverage(),
        )
        return {
          code: transformed,
          map: instrumenter.lastSourceMap() as never,
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
