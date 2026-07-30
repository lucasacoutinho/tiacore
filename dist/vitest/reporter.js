import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { TIA_META_KEY, TIA_REPLAY_META_KEY, TIA_TEST_META_KEY, } from '../shared/constants.js';
import { captureBaseline } from '../graph/baseline.js';
import { portableCoverageMap, writeCoverageReports, } from '../coverage/report.js';
import { projectFingerprint } from '../graph/fingerprint.js';
import { aggregateLocalPartitions } from '../graph/partitions.js';
import { resolveFrameworkEdges } from '../frameworks/resolve.js';
import { directlyImportedAssetFiles, importedAssetFiles, } from './module-graph.js';
import { commitGraph } from '../graph/state.js';
import { updateGraph } from '../graph/update.js';
import { projectRelative } from '../shared/paths.js';
import { notifyReplayAdapters, replayedResults, replayRunEvent, } from '../runtime/replay.js';
import { cachedTestCase } from './cached-test.js';
function baselineDifferences(before, after) {
    return [
        ...new Set([
            ...Object.keys(before.workingTree),
            ...Object.keys(after.workingTree),
        ]),
    ]
        .filter((file) => before.workingTree[file] !== after.workingTree[file])
        .sort();
}
export class TiaReporter {
    runtime;
    collectionCoverage = new Map();
    edges = new Map();
    executedFiles = new Set();
    results = new Map();
    testEdges = new Map();
    testCoverage = new Map();
    incomplete = false;
    vitest = null;
    constructor(runtime) {
        this.runtime = runtime;
    }
    onInit(vitest) {
        this.vitest = vitest;
    }
    async onTestRunStart() {
        const plan = this.runtime.plan;
        if (plan === null) {
            return;
        }
        if (this.runtime.coverage.enabled &&
            this.runtime.coverage.clean) {
            rmSync(this.runtime.coverage.reportsDirectory, {
                force: true,
                recursive: true,
            });
        }
        if (this.runtime.options.log) {
            if (plan.mode === 'record') {
                this.log(`TIA recording full-suite baseline (${plan.reason}).`);
            }
            else {
                this.log(`TIA replay: ${plan.reason}; ${plan.replayedTests} cached test result${plan.replayedTests === 1 ? '' : 's'}.`);
            }
        }
        await notifyReplayAdapters(this.runtime.options.replayAdapters, 'onRunStart', replayRunEvent(plan), (message) => this.warn(message));
        for (const result of replayedResults(plan)) {
            await notifyReplayAdapters(this.runtime.options.replayAdapters, 'onTestReplayed', { result: structuredClone(result) }, (message) => this.warn(message));
            await this.notifyReplayReporters(result);
        }
    }
    onTestModuleEnd(module) {
        const testFile = projectRelative(this.runtime.root, module.moduleId);
        if (testFile === null || testFile === '') {
            return;
        }
        const value = module.meta()[TIA_META_KEY];
        if (value === undefined) {
            this.incomplete = true;
            return;
        }
        const dependencies = new Set([testFile]);
        const sharedTestDependencies = new Set([testFile]);
        this.collectionCoverage.set(testFile, portableCoverageMap(this.runtime.root, value.collectionCoverage));
        for (const file of value.files) {
            const dependency = projectRelative(this.runtime.root, file);
            if (dependency !== null && dependency !== '') {
                dependencies.add(dependency);
            }
        }
        for (const file of value.collectionFiles) {
            const dependency = projectRelative(this.runtime.root, file);
            if (dependency !== null && dependency !== '') {
                sharedTestDependencies.add(dependency);
            }
        }
        const moduleFrameworkEdges = resolveFrameworkEdges(this.runtime.options.frameworkAdapters, {
            files: [...dependencies],
            root: this.runtime.root,
            testFile,
        });
        if (!moduleFrameworkEdges.complete) {
            this.incomplete = true;
        }
        for (const file of moduleFrameworkEdges.files) {
            dependencies.add(file);
            sharedTestDependencies.add(file);
        }
        if (module.viteEnvironment !== undefined) {
            const moduleGraph = module.viteEnvironment.moduleGraph;
            const sharedAssets = new Set(directlyImportedAssetFiles(moduleGraph, module.moduleId, this.runtime.root));
            for (const collectionFile of value.collectionFiles) {
                for (const asset of importedAssetFiles(moduleGraph, collectionFile, this.runtime.root)) {
                    sharedAssets.add(asset);
                }
            }
            for (const asset of sharedAssets) {
                dependencies.add(asset);
                sharedTestDependencies.add(asset);
            }
            for (const [id, edge] of this.testEdges) {
                if (edge.file !== testFile) {
                    continue;
                }
                const caseAssets = new Set();
                for (const dependency of edge.files) {
                    if (dependency === testFile) {
                        continue;
                    }
                    for (const asset of importedAssetFiles(moduleGraph, resolve(this.runtime.root, dependency), this.runtime.root)) {
                        caseAssets.add(asset);
                        dependencies.add(asset);
                    }
                }
                this.testEdges.set(id, {
                    file: edge.file,
                    files: [...new Set([...edge.files, ...caseAssets])].sort(),
                });
            }
        }
        for (const [id, edge] of this.testEdges) {
            if (edge.file === testFile) {
                if (value.concurrent) {
                    this.testEdges.delete(id);
                    this.testCoverage.delete(id);
                }
                else {
                    this.testEdges.set(id, {
                        file: edge.file,
                        files: [
                            ...new Set([...edge.files, ...sharedTestDependencies]),
                        ].sort(),
                    });
                }
            }
        }
        this.executedFiles.add(testFile);
        this.edges.set(testFile, [...dependencies].sort());
    }
    onTestCaseResult(testCase) {
        const result = testCase.result();
        if (result.state === 'pending') {
            return;
        }
        if (testCase.meta()[TIA_REPLAY_META_KEY] === true) {
            return;
        }
        const file = projectRelative(this.runtime.root, testCase.module.moduleId);
        if (file === null || file === '') {
            return;
        }
        const diagnostic = testCase.diagnostic();
        this.results.set(testCase.id, {
            ...(diagnostic === undefined ? {} : { duration: diagnostic.duration }),
            file,
            fullName: testCase.fullName,
            id: testCase.id,
            state: result.state,
        });
        const meta = testCase.meta()[TIA_TEST_META_KEY];
        if (meta === undefined) {
            if (result.state !== 'skipped') {
                this.incomplete = true;
            }
            return;
        }
        const dependencies = new Set([file]);
        for (const dependencyFile of meta.files) {
            const dependency = projectRelative(this.runtime.root, dependencyFile);
            if (dependency !== null && dependency !== '') {
                dependencies.add(dependency);
            }
        }
        const frameworkEdges = resolveFrameworkEdges(this.runtime.options.frameworkAdapters, {
            files: [...dependencies],
            root: this.runtime.root,
            testFile: file,
        });
        if (!frameworkEdges.complete) {
            this.incomplete = true;
        }
        for (const dependency of frameworkEdges.files) {
            dependencies.add(dependency);
        }
        this.testEdges.set(testCase.id, {
            file,
            files: [...dependencies].sort(),
        });
        this.testCoverage.set(testCase.id, portableCoverageMap(this.runtime.root, meta.coverage));
    }
    async onTestRunEnd(modules, unhandledErrors, reason) {
        const plan = this.runtime.plan;
        if (plan === null) {
            return;
        }
        if (reason === 'interrupted') {
            this.warn('TIA graph was not updated because the run was interrupted.');
            return;
        }
        if (unhandledErrors.length > 0) {
            this.warn('TIA graph was not updated because Vitest reported an unhandled error.');
            return;
        }
        if (this.incomplete) {
            this.warn('TIA graph was not updated because dependency metadata was incomplete.');
            return;
        }
        this.recordModuleFailures(modules);
        const fingerprint = projectFingerprint(this.runtime.root, this.runtime.options, this.runtime.structuralFiles);
        if (fingerprint !== this.runtime.fingerprintAtStart) {
            this.warn('TIA graph was not updated because project structure changed during the run.');
            return;
        }
        const baseline = captureBaseline(this.runtime.root, this.runtime.ignoredPrefixes);
        if (baseline === null) {
            this.warn('TIA graph was not updated because the Git baseline is unavailable.');
            return;
        }
        if (this.runtime.baselineAtStart === null ||
            JSON.stringify(baseline) !== JSON.stringify(this.runtime.baselineAtStart)) {
            const changed = this.runtime.baselineAtStart === null
                ? []
                : baselineDifferences(this.runtime.baselineAtStart, baseline);
            this.warn(`TIA graph was not updated because project files changed during the run.${changed.length === 0
                ? ''
                : ` Changed: ${changed.slice(0, 10).join(', ')}${changed.length > 10 ? ', …' : ''}.`}`);
            return;
        }
        const recordComplete = plan.mode !== 'record' ||
            this.runtime.partition !== null ||
            await this.recordIncludesEveryConfiguredTestFile(modules);
        const graph = updateGraph({
            collectionCoverage: this.collectionCoverage,
            executedFiles: this.executedFiles,
            fallbackEdges: this.edges,
            fullyExecutedFiles: plan.mode === 'record'
                ? this.executedFiles
                : [...this.executedFiles].filter((file) => plan.wholeTestFiles.includes(file)),
            previous: plan.mode === 'record' ? null : plan.graph,
            results: this.results,
            root: this.runtime.root,
            testCoverage: this.testCoverage,
            testEdges: this.testEdges,
        });
        graph.baseline = baseline;
        graph.complete =
            this.runtime.partition === null && recordComplete;
        graph.coverageComplete =
            plan.mode === 'record' ? recordComplete : graph.coverageComplete;
        graph.fingerprint = fingerprint;
        if (this.runtime.partition === null) {
            delete graph.partition;
        }
        else {
            graph.partition = structuredClone(this.runtime.partition);
        }
        graph.updatedAt = new Date().toISOString();
        const committed = await commitGraph(this.runtime.writeCacheDir, {
            expected: this.runtime.graphAtStart,
            expectedDigest: this.runtime.graphDigestAtStart,
            graph,
        });
        if (committed.status === 'conflict' || committed.graph === null) {
            this.warn('TIA graph was not updated because another process committed a conflicting graph.');
            return;
        }
        let savedGraph = committed.graph;
        if (this.runtime.partition !== null) {
            savedGraph =
                await aggregateLocalPartitions(this.runtime.options.cacheDir, this.runtime.partition) ?? savedGraph;
        }
        if (!recordComplete) {
            this.warn('TIA saved an incomplete graph because Vitest did not execute every configured test file.');
        }
        const coverageReady = this.runtime.partition === null || savedGraph.complete;
        const failedRun = modules.some((module) => !module.ok());
        const shouldReportCoverage = this.runtime.coverage.enabled &&
            coverageReady &&
            (!failedRun || this.runtime.coverage.reportOnFailure);
        if (shouldReportCoverage) {
            const canCheckThresholds = savedGraph.complete && savedGraph.coverageComplete;
            const report = writeCoverageReports(savedGraph, this.runtime.root, canCheckThresholds
                ? this.runtime.coverage
                : {
                    ...this.runtime.coverage,
                    thresholds: null,
                });
            if (this.runtime.coverage.thresholds !== null &&
                !canCheckThresholds) {
                this.warn('TIA coverage thresholds were deferred because this graph is a partial shard.');
            }
            if (this.runtime.coverage.thresholds?.autoUpdate) {
                this.warn('TIA enforced coverage thresholds but did not rewrite the Vitest config for thresholds.autoUpdate.');
            }
            for (const warning of report.warnings) {
                this.warn(warning);
            }
            for (const failure of report.thresholdFailures) {
                process.exitCode = 1;
                this.error(failure.message);
            }
            if (this.runtime.options.log) {
                this.log(`TIA coverage reconstructed: ${report.files} source file${report.files === 1 ? '' : 's'} in ${this.runtime.coverage.reportsDirectory}.`);
            }
        }
        if (this.runtime.coverage.enabled &&
            !coverageReady &&
            this.runtime.coverage.thresholds !== null) {
            this.warn('TIA coverage thresholds were deferred because this graph is a partial shard.');
        }
        if (this.runtime.options.log) {
            const replayed = plan.mode === 'replay' ? plan.replayedTests : 0;
            this.log(`TIA graph saved: ${this.executedFiles.size} executed file${this.executedFiles.size === 1 ? '' : 's'}, ${replayed} replayed result${replayed === 1 ? '' : 's'}.`);
        }
        await notifyReplayAdapters(this.runtime.options.replayAdapters, 'onRunComplete', {
            ...replayRunEvent(plan),
            coverageReportDirectory: shouldReportCoverage
                ? this.runtime.coverage.reportsDirectory
                : null,
            executedTestFiles: [...this.executedFiles].sort(),
        }, (message) => this.warn(message));
    }
    async recordIncludesEveryConfiguredTestFile(modules) {
        if (this.vitest === null) {
            return false;
        }
        try {
            const expected = new Set();
            for (const project of this.vitest.projects) {
                const files = await project.globTestFiles();
                for (const file of files.testFiles) {
                    const relative = projectRelative(this.runtime.root, file);
                    if (relative !== null && relative !== '') {
                        expected.add(relative);
                    }
                }
            }
            const observed = new Set(modules
                .map((module) => projectRelative(this.runtime.root, module.moduleId))
                .filter((file) => file !== null && file !== ''));
            return [...expected].every((file) => observed.has(file));
        }
        catch {
            return false;
        }
    }
    async notifyReplayReporters(result) {
        if (this.vitest === null ||
            this.runtime.options.replayReporters.length === 0) {
            return;
        }
        const testCase = cachedTestCase(this.vitest, this.runtime.root, result);
        for (const reporter of this.runtime.options.replayReporters) {
            for (const method of [
                'onTestCaseReady',
                'onTestCaseResult',
            ]) {
                const handler = reporter[method];
                if (handler === undefined) {
                    continue;
                }
                try {
                    await handler.call(reporter, testCase);
                }
                catch (error) {
                    this.warn(`TIA replay reporter ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    recordModuleFailures(modules) {
        for (const module of modules) {
            if (module.state() !== 'failed') {
                continue;
            }
            const file = projectRelative(this.runtime.root, module.moduleId);
            if (file === null || file === '') {
                continue;
            }
            const hasFailedTestCase = [...this.results.values()].some((result) => result.file === file &&
                result.state === 'failed' &&
                !result.id.startsWith('module:'));
            if (hasFailedTestCase) {
                continue;
            }
            const id = `module:${file}`;
            this.results.set(id, {
                file,
                fullName: `${file} (module failure)`,
                id,
                state: 'failed',
            });
        }
    }
    log(message) {
        if (this.vitest !== null) {
            this.vitest.logger.log(`\n ${message}`);
            return;
        }
        console.log(message);
    }
    error(message) {
        if (this.vitest !== null) {
            this.vitest.logger.error(message);
            return;
        }
        console.error(message);
    }
    warn(message) {
        if (this.vitest !== null) {
            this.vitest.logger.warn(message);
            return;
        }
        console.warn(message);
    }
}
//# sourceMappingURL=reporter.js.map