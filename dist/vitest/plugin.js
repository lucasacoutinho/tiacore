/// <reference types="vitest/config" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInstrumenter } from 'istanbul-lib-instrument';
import picomatch from 'picomatch';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, PLUGIN_VERSION, TEST_FILE_PATTERN, TIA_SELECTION_KEY, } from '../shared/constants.js';
import { artifactProviders, restoreGraphFromArtifacts, } from '../artifacts/restore.js';
import { projectFingerprint } from '../graph/fingerprint.js';
import { captureBaseline } from '../graph/baseline.js';
import { createRunPlan } from '../graph/plan.js';
import { partitionCacheDir, partitionGroup, } from '../graph/partitions.js';
import { graphDigest, purgeGraph, readGraph, } from '../graph/state.js';
import { frameworkAdapters, frameworkFingerprint, } from '../frameworks/index.js';
import { isInside, projectRelative, resolveCacheDir, slash, } from '../shared/paths.js';
import { TiaReporter } from './reporter.js';
const sharedStateKey = Symbol.for(`tiajs@${PLUGIN_VERSION}/shared-state`);
const sharedStates = globalThis[sharedStateKey] ??= new WeakMap();
const runtimeStateKey = Symbol.for(`tiajs@${PLUGIN_VERSION}/browser-runtime-state`);
const runtimeStates = globalThis[runtimeStateKey] ??= new Map();
function envFlag(name) {
    return /^(?:1|true|yes|on)$/i.test(process.env[name] ?? '');
}
function defaultEnabled() {
    if (process.env.TIA !== undefined) {
        return envFlag('TIA');
    }
    return (envFlag('CI') ||
        process.argv.includes('run') ||
        process.argv.includes('--run'));
}
function hasCliFileFilter(root) {
    const optionValues = new Set([
        '--config',
        '-c',
        '--dir',
        '--root',
    ]);
    const arguments_ = process.argv.slice(2);
    return arguments_.some((argument, index) => {
        if (argument.startsWith('-')) {
            return false;
        }
        const previous = arguments_[index - 1];
        if (previous !== undefined && optionValues.has(previous)) {
            return false;
        }
        const clean = slash(argument.replace(/:\d+$/, ''));
        return (TEST_FILE_PATTERN.test(clean) ||
            (clean !== 'run' &&
                clean !== 'watch' &&
                existsSync(resolve(root, clean)) &&
                !clean.includes('.config.')));
    });
}
function hasNativeSelection(root, config) {
    return (Boolean(config.changed) ||
        (config.cliExclude?.length ?? 0) > 0 ||
        (config.filters?.length ?? 0) > 0 ||
        (config.project?.length ?? 0) > 0 ||
        (config.related?.length ?? 0) > 0 ||
        (config.tagsFilter?.length ?? 0) > 0 ||
        config.testNamePattern !== undefined ||
        hasCliFileFilter(root));
}
function normalizeOptions(options) {
    const requestedCoverage = options.coverage === true ? {} : options.coverage || null;
    const adapters = frameworkAdapters(options.frameworks);
    const shardGroup = options.shardGroup ??
        (process.env.TIA_SHARD_GROUP?.trim() === ''
            ? undefined
            : process.env.TIA_SHARD_GROUP);
    return {
        artifactProviders: artifactProviders(options.artifacts),
        cacheDir: options.cacheDir ?? '.tia',
        coverage: requestedCoverage === null
            ? false
            : {
                clean: requestedCoverage.clean ?? true,
                cleanOnRerun: requestedCoverage.cleanOnRerun ?? true,
                exclude: requestedCoverage.exclude ?? [],
                include: requestedCoverage.include ?? null,
                reportOnFailure: requestedCoverage.reportOnFailure ?? false,
                reporters: requestedCoverage.reporters ?? [
                    'text',
                    'html',
                    'json',
                ],
                reportsDirectory: requestedCoverage.reportsDirectory ?? 'coverage',
                skipFull: requestedCoverage.skipFull ?? false,
                thresholds: requestedCoverage.thresholds ?? null,
                watermarks: {
                    branches: requestedCoverage.watermarks?.branches ?? [50, 80],
                    functions: requestedCoverage.watermarks?.functions ?? [50, 80],
                    lines: requestedCoverage.watermarks?.lines ?? [50, 80],
                    statements: requestedCoverage.watermarks?.statements ?? [50, 80],
                },
            },
        enabled: options.enabled ?? defaultEnabled(),
        exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
        fresh: options.fresh ?? envFlag('TIA_FRESH'),
        frameworkAdapters: adapters,
        frameworkFingerprint: frameworkFingerprint(adapters),
        ignoreChanges: options.ignoreChanges ?? [],
        include: options.include ?? DEFAULT_INCLUDE,
        log: options.log ?? true,
        onUnknownChange: options.onUnknownChange ?? 'full',
        replayAdapters: options.replayAdapters === undefined
            ? []
            : Array.isArray(options.replayAdapters)
                ? options.replayAdapters
                : [options.replayAdapters],
        replayReporters: options.replayReporters === undefined
            ? []
            : [
                ...new Set(Array.isArray(options.replayReporters)
                    ? options.replayReporters
                    : [options.replayReporters]),
            ],
        ...(shardGroup === undefined ? {} : { shardGroup }),
    };
}
const DEFAULT_COVERAGE_REPORTERS = [
    'text',
    'html',
    'json',
];
function coverageReporters(value) {
    const configured = typeof value === 'string'
        ? [value]
        : Array.isArray(value)
            ? value
            : DEFAULT_COVERAGE_REPORTERS;
    const reporters = [];
    for (const item of configured) {
        if (typeof item === 'string' && item !== '') {
            reporters.push({ name: item, options: {} });
            continue;
        }
        if (!Array.isArray(item) ||
            typeof item[0] !== 'string' ||
            item[0] === '') {
            continue;
        }
        const value = item[1];
        reporters.push({
            name: item[0],
            options: value !== null &&
                typeof value === 'object' &&
                !Array.isArray(value)
                ? { ...value }
                : {},
        });
    }
    return reporters.length === 0
        ? coverageReporters(DEFAULT_COVERAGE_REPORTERS)
        : reporters;
}
function coverageRuntime(root, configured, native) {
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
            watermarks: {
                branches: [50, 80],
                functions: [50, 80],
                lines: [50, 80],
                statements: [50, 80],
            },
        };
    }
    const runtime = {
        clean: configured === false
            ? native?.clean ?? true
            : configured.clean,
        cleanOnRerun: configured === false
            ? native?.cleanOnRerun ?? true
            : configured.cleanOnRerun,
        enabled: true,
        exclude: configured === false
            ? native?.exclude ?? []
            : configured.exclude,
        include: configured === false
            ? native?.include ?? null
            : configured.include,
        reportOnFailure: configured === false
            ? native?.reportOnFailure ?? false
            : configured.reportOnFailure,
        reporters: configured === false
            ? coverageReporters(native?.reporter)
            : coverageReporters(configured.reporters),
        reportsDirectory: resolve(root, configured === false
            ? native?.reportsDirectory ?? 'coverage'
            : configured.reportsDirectory),
        skipFull: configured === false
            ? native?.skipFull ?? false
            : configured.skipFull,
        thresholds: configured === false
            ? (native?.thresholds !== null &&
                typeof native?.thresholds === 'object'
                ? native.thresholds
                : null)
            : configured.thresholds ?? (native?.thresholds !== null &&
                typeof native?.thresholds === 'object'
                ? native.thresholds
                : null),
        watermarks: configured === false
            ? {
                branches: native?.watermarks?.branches ?? [50, 80],
                functions: native?.watermarks?.functions ?? [50, 80],
                lines: native?.watermarks?.lines ?? [50, 80],
                statements: native?.watermarks?.statements ?? [50, 80],
            }
            : configured.watermarks,
    };
    if (runtime.reportsDirectory === resolve(root) ||
        dirname(runtime.reportsDirectory) === runtime.reportsDirectory) {
        throw new Error(`tiajs cannot use the project or filesystem root as coverage.reportsDirectory: ${runtime.reportsDirectory}`);
    }
    return runtime;
}
function normalizeSetupFiles(value) {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === 'string');
    }
    return [];
}
function impossibleTestPattern(cacheDir) {
    return slash(resolve(cacheDir, '__no_affected_tests__', '**', '*.{test,spec}.ts'));
}
function setupProxyPath(root, cacheDir) {
    const resolvedCache = resolveCacheDir(root, cacheDir);
    const localCache = isInside(root, resolvedCache)
        ? resolvedCache
        : resolve(root, '.tia');
    return resolve(localCache, 'runtime', `setup-${PLUGIN_VERSION}.mjs`);
}
function pluginSetupPath() {
    const localCompiled = fileURLToPath(new URL('./setup.js', import.meta.url));
    const compiled = [
        localCompiled,
        fileURLToPath(new URL('./vitest/setup.js', import.meta.url)),
    ];
    for (const candidate of compiled) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    const source = fileURLToPath(new URL('./setup.ts', import.meta.url));
    return existsSync(source) ? source : localCompiled;
}
function ensureSetupProxy(root, cacheDir, setupPath) {
    const proxyPath = setupProxyPath(root, cacheDir);
    const contents = `import ${JSON.stringify(pathToFileURL(setupPath).href)}\n`;
    if (!existsSync(proxyPath) ||
        readFileSync(proxyPath, 'utf8') !== contents) {
        mkdirSync(dirname(proxyPath), { recursive: true });
        writeFileSync(proxyPath, contents);
    }
    return proxyPath;
}
function affectedTestsForProject(affectedTests, globalRoot, projectRoot, include, exclude) {
    const includes = picomatch(include, { dot: true });
    const excludes = picomatch(exclude, { dot: true });
    return affectedTests
        .map((file) => {
        const absolute = resolve(globalRoot, file);
        return {
            absolute: slash(absolute),
            projectRelative: slash(relative(projectRoot, absolute)),
            rootRelative: file,
        };
    })
        .filter((file) => !file.projectRelative.startsWith('../') &&
        (includes(file.projectRelative) ||
            includes(file.rootRelative) ||
            includes(file.absolute)) &&
        !(excludes(file.projectRelative) ||
            excludes(file.rootRelative) ||
            excludes(file.absolute)))
        .map((file) => file.projectRelative);
}
export function tia(options = {}) {
    const normalized = normalizeOptions(options);
    const setupPath = pluginSetupPath();
    let runtime = {
        active: false,
        baselineAtStart: null,
        coverage: {
            clean: true,
            cleanOnRerun: true,
            enabled: false,
            exclude: [],
            include: null,
            reportOnFailure: false,
            reporters: [],
            reportsDirectory: resolve(process.cwd(), 'coverage'),
            skipFull: false,
            thresholds: null,
            watermarks: {
                branches: [50, 80],
                functions: [50, 80],
                lines: [50, 80],
                statements: [50, 80],
            },
        },
        fingerprintAtStart: '',
        graphAtStart: null,
        graphDigestAtStart: null,
        ignoredPrefixes: [],
        instrumenter: null,
        options: normalized,
        partition: null,
        plan: null,
        root: process.cwd(),
        structuralFiles: [],
        writeCacheDir: resolve(process.cwd(), normalized.cacheDir),
    };
    let includeMatcher = null;
    let excludeMatcher = null;
    return {
        name: 'tiajs',
        enforce: 'post',
        config(config) {
            if (!normalized.enabled) {
                return;
            }
            const root = resolve(config.root ?? process.cwd());
            const runtimeKey = `${slash(root)}\0${slash(resolveCacheDir(root, normalized.cacheDir))}`;
            const existingRuntime = runtimeStates.get(runtimeKey);
            if (existingRuntime === undefined) {
                runtimeStates.set(runtimeKey, runtime);
            }
            else {
                runtime = existingRuntime;
            }
            const setupProxy = ensureSetupProxy(root, normalized.cacheDir, setupPath);
            config.test ??= {};
            const setupFiles = normalizeSetupFiles(config.test.setupFiles);
            if (!setupFiles.includes(setupProxy)) {
                config.test.setupFiles = [...setupFiles, setupProxy];
            }
        },
        async configureVitest({ project, vitest }) {
            if (!normalized.enabled) {
                return;
            }
            let shared = sharedStates.get(vitest);
            if (shared === undefined) {
                shared = {
                    bypassed: false,
                    excludeMatcher: null,
                    includeMatcher: null,
                    initialized: false,
                    runtime,
                    selectedProjects: new Set(),
                };
                sharedStates.set(vitest, shared);
            }
            else {
                runtime = shared.runtime;
                includeMatcher = shared.includeMatcher;
                excludeMatcher = shared.excludeMatcher;
            }
            if (shared.bypassed) {
                return;
            }
            const candidates = [...new Set([...vitest.projects, project])];
            const selectAll = {
                mode: 'all',
                testIds: [],
                wholeTestFiles: [],
            };
            const nativeCoverageProject = candidates.find((candidate) => candidate.config.coverage.enabled);
            if (vitest.config.watch ||
                hasNativeSelection(resolve(vitest.config.root ?? process.cwd()), vitest.config)) {
                for (const candidate of candidates) {
                    candidate.provide(TIA_SELECTION_KEY, selectAll);
                }
                runtime.active = false;
                shared.bypassed = true;
                return;
            }
            if (!shared.initialized) {
                runtime.root = resolve(vitest.config.root);
                runtime.options = {
                    ...normalized,
                    cacheDir: resolveCacheDir(runtime.root, normalized.cacheDir),
                };
                runtime.coverage = coverageRuntime(runtime.root, normalized.coverage, nativeCoverageProject?.config.coverage ?? null);
                if (nativeCoverageProject !== undefined) {
                    vitest.disableCoverage();
                }
                const cachePrefix = projectRelative(runtime.root, runtime.options.cacheDir) ?? '';
                runtime.ignoredPrefixes = [
                    cachePrefix,
                    projectRelative(runtime.root, runtime.coverage.reportsDirectory),
                    ...candidates
                        .map((candidate) => projectRelative(runtime.root, resolve(runtime.root, candidate.config.coverage.reportsDirectory)))
                        .filter((file) => file !== null),
                ].filter((file) => file !== null && file !== '');
                runtime.structuralFiles = [
                    ...new Set([...vitest.projects, project]
                        .map((candidate) => candidate.vite.config.configFile)
                        .filter((file) => typeof file === 'string')
                        .map((file) => projectRelative(runtime.root, file))
                        .filter((file) => file !== null)),
                ];
                runtime.fingerprintAtStart = projectFingerprint(runtime.root, runtime.options, runtime.structuralFiles);
                runtime.baselineAtStart = captureBaseline(runtime.root, runtime.ignoredPrefixes);
                runtime.partition =
                    vitest.config.shard === undefined
                        ? null
                        : {
                            group: partitionGroup(runtime.baselineAtStart, runtime.fingerprintAtStart, vitest.config.shard.count, runtime.options.shardGroup),
                            index: vitest.config.shard.index,
                            total: vitest.config.shard.count,
                        };
                runtime.writeCacheDir =
                    runtime.partition === null
                        ? runtime.options.cacheDir
                        : partitionCacheDir(runtime.options.cacheDir, runtime.partition);
                if (runtime.partition === null) {
                    if (runtime.options.fresh) {
                        purgeGraph(runtime.options.cacheDir);
                    }
                    else if (runtime.options.artifactProviders.length > 0) {
                        await restoreGraphFromArtifacts({
                            cacheDir: runtime.options.cacheDir,
                            coverageRequested: runtime.coverage.enabled,
                            fingerprint: runtime.fingerprintAtStart,
                            log: runtime.options.log,
                            providers: runtime.options.artifactProviders,
                            root: runtime.root,
                        });
                    }
                }
                else if (runtime.options.fresh) {
                    purgeGraph(runtime.writeCacheDir);
                }
                const graph = readGraph(runtime.writeCacheDir);
                runtime.graphAtStart = graph;
                runtime.graphDigestAtStart = graphDigest(graph);
                runtime.plan = createRunPlan({
                    cachePrefix,
                    coverageRequested: runtime.coverage.enabled,
                    fingerprint: runtime.fingerprintAtStart,
                    graph: runtime.partition === null ? graph : null,
                    ignoredPrefixes: runtime.ignoredPrefixes,
                    options: runtime.options,
                    root: runtime.root,
                });
                runtime.active = true;
                shared.initialized = true;
                vitest.config.reporters.push(new TiaReporter(runtime));
                includeMatcher = picomatch(runtime.options.include, { dot: true });
                excludeMatcher = picomatch(runtime.options.exclude, { dot: true });
                shared.includeMatcher = includeMatcher;
                shared.excludeMatcher = excludeMatcher;
            }
            const plan = runtime.plan;
            if (plan === null) {
                return;
            }
            if (plan.mode === 'record') {
                for (const candidate of candidates) {
                    candidate.provide(TIA_SELECTION_KEY, selectAll);
                }
                return;
            }
            if (plan.mode === 'replay') {
                vitest.config.passWithNoTests = true;
                const selection = {
                    mode: 'tests',
                    testIds: plan.affectedTestIds,
                    wholeTestFiles: plan.wholeTestFiles.map((file) => slash(resolve(runtime.root, file))),
                };
                for (const candidate of candidates) {
                    if (shared.selectedProjects.has(candidate)) {
                        continue;
                    }
                    shared.selectedProjects.add(candidate);
                    candidate.provide(TIA_SELECTION_KEY, selection);
                    const candidateConfig = candidate.config;
                    const affectedTests = affectedTestsForProject(plan.affectedTests, runtime.root, resolve(candidateConfig.root), candidateConfig.include, candidateConfig.exclude);
                    candidateConfig.include =
                        affectedTests.length === 0
                            ? [impossibleTestPattern(runtime.options.cacheDir)]
                            : affectedTests;
                    candidateConfig.passWithNoTests = true;
                }
            }
        },
        transform(code, id) {
            if (!runtime.active) {
                return;
            }
            includeMatcher ??= picomatch(runtime.options.include, { dot: true });
            excludeMatcher ??= picomatch(runtime.options.exclude, { dot: true });
            const cleanId = id.split('?', 1)[0];
            if (cleanId === undefined ||
                cleanId.startsWith('\0') ||
                !isInside(runtime.root, cleanId)) {
                return;
            }
            const relativeId = slash(relative(runtime.root, cleanId));
            if (!includeMatcher(relativeId) || excludeMatcher(relativeId)) {
                return;
            }
            runtime.instrumenter ??= createInstrumenter({
                coverageVariable: '__coverage__',
                esModules: true,
                produceSourceMap: true,
            });
            try {
                const inputMap = this.getCombinedSourcemap();
                const transformed = runtime.instrumenter.instrumentSync(code, cleanId, inputMap.mappings === ''
                    ? undefined
                    : inputMap);
                return {
                    code: transformed,
                    map: runtime.instrumenter.lastSourceMap(),
                };
            }
            catch (error) {
                this.warn(`tiajs could not instrument ${relativeId}: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
        },
    };
}
//# sourceMappingURL=plugin.js.map