import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'tinyglobby';
import { TiaCore } from './core.js';
import { groupBy, normalizedConcurrency, parallelMap, } from './parallel.js';
import { fullyExecutedFiles, moduleFailureObservation, } from './observations.js';
import { isInside, slash } from '../shared/paths.js';
function runnerAsset(name) {
    const moduleAsset = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (existsSync(moduleAsset)) {
        return moduleAsset;
    }
    return fileURLToPath(new URL(`./runners/${name}`, import.meta.url));
}
const DEFAULT_NODE_TESTS = [
    'test/**/*.test.{js,cjs,mjs,ts,cts,mts}',
    'test-*.{js,cjs,mjs,ts,cts,mts}',
    '**/*.test.{js,cjs,mjs,ts,cts,mts}',
];
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function nodeVersionSupported() {
    const [major = 0, minor = 0] = process.versions.node
        .split('.')
        .map(Number);
    return major > 22 || (major === 22 && minor >= 10);
}
function nodeDiscoveryHooksSupported() {
    if (process.env.TIAJS_NODE_DISCOVERY_HOOKS === '0') {
        return false;
    }
    const [major = 0, minor = 0] = process.versions.node
        .split('.')
        .map(Number);
    return major > 22 || (major === 22 && minor >= 15);
}
function testId(file, line, column, name) {
    return `${file}:${line}:${column}:${name}`;
}
class NodeTiaRunner {
    core;
    concurrency;
    files;
    log;
    root;
    discoveryRegister = runnerAsset('node-discovery-register.js');
    executionChild = runnerAsset('node-execution-child.js');
    constructor(options) {
        this.root = resolve(options.root ?? process.cwd());
        this.concurrency = normalizedConcurrency(options.concurrency);
        this.files = this.resolveFiles(options.files ?? DEFAULT_NODE_TESTS);
        this.log = options.log ?? true;
        this.core = new TiaCore({
            ...options,
            files: options.files ?? DEFAULT_NODE_TESTS,
            root: this.root,
            runner: 'node',
        });
    }
    async run() {
        if (!nodeVersionSupported()) {
            throw new Error('tiajs/node requires Node.js 22.10 or newer for programmatic test coverage');
        }
        const plan = await this.core.prepare();
        this.print(plan.mode === 'record'
            ? `TIA node recording full-suite baseline (${plan.reason}).`
            : `TIA node replay: ${plan.reason}; ${plan.replayedTests} cached test result${plan.replayedTests === 1 ? '' : 's'}.`);
        const observations = [];
        const wholeFiles = plan.mode === 'record'
            ? this.files.map((file) => slash(relative(this.root, file)))
            : plan.wholeTestFiles;
        if (plan.mode === 'record') {
            observations.push(...(await this.observeFiles(this.files)));
        }
        else {
            observations.push(...(await this.observeFiles(plan.wholeTestFiles.map((file) => resolve(this.root, file)))));
            const cached = plan.affectedTestIds.flatMap((id) => {
                const result = plan.graph?.results[id];
                return result === undefined ? [] : [result];
            });
            observations.push(...(await this.observeCachedCases(cached)));
        }
        const graph = await this.core.commit(observations, fullyExecutedFiles(plan, observations, wholeFiles));
        const success = observations.every((observation) => observation.state !== 'failed');
        this.print(`TIA node complete: ${observations.length} executed, ${plan.replayedTests} replayed.`);
        return {
            executedTests: observations,
            graphSaved: graph !== null,
            plan,
            replayedTests: plan.replayedTests,
            success,
        };
    }
    async observeFiles(files) {
        if (files.length === 0) {
            return [];
        }
        const discovery = await this.discover(files);
        const observations = [];
        if (discovery.aggregate) {
            return discovery.cases.map((testCase) => this.observation(testCase, [
                testCase.file,
                ...discovery.coverageFiles,
            ]));
        }
        const groups = groupBy(discovery.cases, (candidate) => candidate.file);
        observations.push(...(await parallelMap([...groups.values()], this.concurrency, async (candidates) => {
            const fileObservations = [];
            for (const candidate of candidates) {
                if (candidate.state === 'skipped') {
                    fileObservations.push(this.observation(candidate, [candidate.file]));
                    continue;
                }
                const execution = await this.execute([resolve(this.root, candidate.file)], new RegExp(`^${escapeRegExp(candidate.fullName)}$`), true);
                const executed = execution.cases.find((item) => item.id === candidate.id ||
                    item.fullName === candidate.fullName ||
                    item.fullName === candidate.name ||
                    candidate.fullName.endsWith(` ${item.fullName}`));
                const result = executed === undefined
                    ? {
                        ...candidate,
                        state: 'failed',
                    }
                    : {
                        ...executed,
                        column: candidate.column,
                        file: candidate.file,
                        fullName: candidate.fullName,
                        id: candidate.id,
                        line: candidate.line,
                    };
                fileObservations.push(this.observation(result, [
                    candidate.file,
                    ...execution.coverageFiles,
                ]));
            }
            return fileObservations;
        })).flat());
        const observedFiles = new Set(observations.map((item) => item.file));
        for (const file of discovery.moduleFailures) {
            if (!observedFiles.has(file)) {
                observations.push(moduleFailureObservation(file));
            }
        }
        return observations;
    }
    async observeCachedCases(cached) {
        const groups = groupBy(cached, (result) => result.file);
        return (await parallelMap([...groups.values()], this.concurrency, async (results) => {
            const observations = [];
            for (const result of results) {
                observations.push(...(await this.observeCachedCase(result)));
            }
            return observations;
        })).flat();
    }
    async observeCachedCase(cached) {
        const moduleFailure = cached.id === `module:${cached.file}`;
        const execution = await this.execute([resolve(this.root, cached.file)], moduleFailure
            ? undefined
            : new RegExp(`^${escapeRegExp(cached.fullName)}$`), true);
        if (moduleFailure && execution.cases.length > 0) {
            return execution.cases.map((testCase) => this.observation(testCase, [
                cached.file,
                ...execution.coverageFiles,
            ]));
        }
        const executed = execution.cases.find((item) => item.id === cached.id ||
            item.fullName === cached.fullName ||
            cached.fullName.endsWith(` ${item.fullName}`));
        const result = executed === undefined
            ? undefined
            : {
                ...executed,
                fullName: cached.fullName,
                id: cached.id,
            };
        if (result !== undefined) {
            return [
                this.observation(result, [
                    cached.file,
                    ...execution.coverageFiles,
                ]),
            ];
        }
        if (execution.moduleFailures.length > 0) {
            return execution.moduleFailures.map(moduleFailureObservation);
        }
        return [];
    }
    observation(testCase, files) {
        return {
            ...(testCase.duration === undefined
                ? {}
                : { duration: testCase.duration }),
            file: testCase.file,
            files: [...new Set(files)].sort(),
            fullName: testCase.fullName,
            id: testCase.id,
            state: testCase.state,
        };
    }
    async discover(files) {
        if (!nodeDiscoveryHooksSupported()) {
            const aggregate = await this.execute(files, undefined, true);
            return { ...aggregate, aggregate: true };
        }
        const temporary = mkdtempSync(join(tmpdir(), 'tiajs-node-discovery-'));
        const output = join(temporary, 'cases.jsonl');
        writeFileSync(output, '');
        try {
            const moduleFailures = (await parallelMap(files, this.concurrency, async (file) => await this.discoverFile(file, output))).filter((file) => file !== null);
            const cases = readFileSync(output, 'utf8')
                .split('\n')
                .filter(Boolean)
                .flatMap((line) => {
                try {
                    const record = JSON.parse(line);
                    const absoluteFile = resolve(record.file);
                    if (!isInside(this.root, absoluteFile)) {
                        return [];
                    }
                    const file = slash(relative(this.root, absoluteFile));
                    return [
                        {
                            column: record.column,
                            file,
                            fullName: record.fullName,
                            id: testId(file, record.line, record.column, record.fullName),
                            line: record.line,
                            state: record.skipped ? 'skipped' : 'passed',
                            name: record.name,
                        },
                    ];
                }
                catch {
                    return [];
                }
            });
            if (cases.length === 0 && moduleFailures.length === 0) {
                const aggregate = await this.execute(files, undefined, true);
                return { ...aggregate, aggregate: true };
            }
            return {
                aggregate: false,
                cases,
                coverageFiles: [],
                moduleFailures,
                success: moduleFailures.length === 0,
            };
        }
        finally {
            rmSync(temporary, { force: true, recursive: true });
        }
    }
    async discoverFile(file, output) {
        const environment = {
            ...process.env,
            TIAJS_NODE_DISCOVERY_FILE: output,
        };
        delete environment.NODE_TEST_CONTEXT;
        const status = await new Promise((resolveStatus) => {
            const child = spawn(process.execPath, ['--import', this.discoveryRegister, file], {
                cwd: this.root,
                env: environment,
                stdio: 'ignore',
            });
            child.on('error', () => {
                resolveStatus(null);
            });
            child.on('close', resolveStatus);
        });
        return status === 0
            ? null
            : slash(relative(this.root, file));
    }
    async execute(files, pattern, coverage) {
        const temporary = mkdtempSync(join(tmpdir(), 'tiajs-node-execution-'));
        const request = join(temporary, 'request.json');
        const output = join(temporary, 'result.json');
        writeFileSync(request, JSON.stringify({
            coverage,
            files,
            ...(pattern === undefined
                ? {}
                : {
                    pattern: {
                        flags: pattern.flags,
                        source: pattern.source,
                    },
                }),
            root: this.root,
        }));
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        try {
            await new Promise((resolveChild, rejectChild) => {
                const child = spawn(process.execPath, [this.executionChild, request, output], {
                    cwd: this.root,
                    env: environment,
                    stdio: 'ignore',
                    timeout: 30_000,
                });
                child.on('error', rejectChild);
                child.on('close', () => {
                    resolveChild();
                });
            });
            return JSON.parse(readFileSync(output, 'utf8'));
        }
        catch {
            return {
                cases: [],
                coverageFiles: [],
                moduleFailures: files.map((file) => slash(relative(this.root, file))),
                success: false,
            };
        }
        finally {
            rmSync(temporary, { force: true, recursive: true });
        }
    }
    resolveFiles(patterns) {
        return [
            ...new Set(patterns.flatMap((pattern) => globSync(pattern, {
                cwd: this.root,
                ignore: ['**/node_modules/**', '**/.tia/**'],
            }).map((file) => resolve(this.root, file)))),
        ].sort();
    }
    print(message) {
        if (this.log) {
            console.log(message);
        }
    }
}
export function tia(options = {}) {
    return new NodeTiaRunner(options);
}
//# sourceMappingURL=node.js.map