import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, relative, resolve, } from 'node:path';
import { TiaCore } from '../runners/core.js';
import { slash } from '../shared/paths.js';
import { importedFilesFingerprint, importedProjectFiles, } from './imports.js';
import { PLAYWRIGHT_ROOT_ENV, PLAYWRIGHT_SESSION_ENV, } from './protocol.js';
function runnerName(config) {
    const configName = basename(config)
        .replace(/\.[cm]?[jt]s$/, '')
        .replace(/^playwright(?:\.|$)/, '');
    const stem = (configName === 'config' ? '' : configName)
        .replace(/\.config$/, '')
        .replace(/[^a-z\d]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    return stem === '' ? 'playwright' : `playwright-${stem}`;
}
function configuredRunnerName(config, name) {
    if (name === undefined) {
        return runnerName(config);
    }
    const stem = name
        .replace(/[^a-z\d]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    if (stem === '') {
        throw new Error('Playwright TIA name must contain a letter or number.');
    }
    return stem.startsWith('playwright-') || stem === 'playwright'
        ? stem
        : `playwright-${stem}`;
}
function playwrightCli(cwd) {
    return createRequire(resolve(cwd, 'package.json')).resolve('@playwright/test/cli');
}
function nodeExecutable() {
    const npmNode = process.env.npm_node_execpath;
    return npmNode !== undefined && /(?:^|[\\/])node(?:\.exe)?$/i.test(npmNode)
        ? npmNode
        : 'node';
}
function pathFilter(file) {
    return file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function childStatus(command, arguments_, cwd, environment) {
    return new Promise((resolveStatus, reject) => {
        const child = spawn(command, arguments_, {
            cwd,
            env: environment,
            stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            resolveStatus(code ?? (signal === null ? 1 : 128));
        });
    });
}
function readReport(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
function completeReport(report) {
    const observed = new Set(report.observations.map((observation) => observation.id.replace(/^playwright:/, '')));
    return (report.status !== 'interrupted' &&
        report.status !== 'timedout' &&
        report.observations.every((observation) => observation.dependenciesComplete) &&
        report.configuredTestIds.every((id) => observed.has(id)));
}
function logPlan(plan) {
    if (plan.mode === 'record') {
        console.log(`TIA record: ${plan.reason}.`);
        return;
    }
    console.log(`TIA replay: ${plan.affectedTests.length} affected file${plan.affectedTests.length === 1 ? '' : 's'}, ${plan.replayedTests} cached test${plan.replayedTests === 1 ? '' : 's'}.`);
}
export class TiaPlaywrightRunner {
    options;
    constructor(options) {
        this.options = options;
    }
    async run(arguments_ = []) {
        const root = resolve(this.options.root ?? process.cwd());
        const cwd = resolve(root, this.options.cwd ?? '.');
        const config = resolve(cwd, this.options.config ?? 'playwright.config.ts');
        const runner = configuredRunnerName(config, this.options.name);
        const cacheDir = resolve(root, this.options.cacheDir ?? '.tia');
        const configFingerprint = importedFilesFingerprint(config, root);
        const core = new TiaCore({
            ...(this.options.artifacts === undefined
                ? {}
                : { artifacts: this.options.artifacts }),
            cacheDir,
            files: [slash(relative(root, config)), ...arguments_],
            fingerprint: configFingerprint,
            fresh: this.options.fresh ??
                process.env.TIA_FRESH === '1',
            ...(this.options.ignoreChanges === undefined
                ? {}
                : { ignoreChanges: this.options.ignoreChanges }),
            ...(this.options.log === undefined
                ? {}
                : { log: this.options.log }),
            ...(this.options.onUnknownChange === undefined
                ? {}
                : { onUnknownChange: this.options.onUnknownChange }),
            root,
            runner,
        });
        const plan = await core.prepare();
        if (this.options.log ?? true) {
            logPlan(plan);
        }
        if (plan.mode === 'replay' && plan.affectedTests.length === 0) {
            await core.commit([], []);
            return { plan, status: 0, success: true };
        }
        const runtimeDirectory = resolve(cacheDir, 'runtime');
        mkdirSync(runtimeDirectory, { recursive: true });
        const session = resolve(runtimeDirectory, `${runner}-${process.pid}-${randomUUID()}.json`);
        const affected = plan.mode === 'record'
            ? []
            : plan.affectedTests.map((file) => pathFilter(resolve(root, file)));
        const filters = affected.join('').length > 24_000 ? [] : affected;
        try {
            const cliArguments = [
                playwrightCli(cwd),
                'test',
                '--config',
                config,
                ...arguments_,
                ...filters,
            ];
            const status = await childStatus(nodeExecutable(), cliArguments, cwd, {
                ...process.env,
                [PLAYWRIGHT_ROOT_ENV]: root,
                [PLAYWRIGHT_SESSION_ENV]: session,
            });
            const report = readReport(session);
            if (report === null || !completeReport(report)) {
                if (this.options.log ?? true) {
                    console.warn('TIA graph was not updated because Playwright dependency evidence was incomplete.');
                }
                return { plan, status, success: status === 0 };
            }
            const observations = report.observations.map((observation) => ({
                ...observation,
                files: [
                    ...new Set([
                        ...observation.files,
                        ...importedProjectFiles(resolve(root, observation.file), root),
                    ]),
                ].sort(),
            }));
            await core.commit(observations, [...new Set(observations.map((observation) => observation.file))]);
            return { plan, status, success: status === 0 };
        }
        finally {
            if (existsSync(session)) {
                rmSync(session, { force: true });
            }
        }
    }
}
//# sourceMappingURL=runner.js.map