import type { Reporter, TestCase, TestModule, TestRunEndReason, Vitest } from 'vitest/node';
import type { TiaRuntime } from '../shared/types.js';
export declare class TiaReporter implements Reporter {
    private readonly runtime;
    private readonly collectionCoverage;
    private readonly edges;
    private readonly executedFiles;
    private readonly results;
    private readonly testEdges;
    private readonly testCoverage;
    private incomplete;
    private vitest;
    constructor(runtime: TiaRuntime);
    onInit(vitest: Vitest): void;
    onTestRunStart(): Promise<void>;
    onTestModuleEnd(module: TestModule): void;
    onTestCaseResult(testCase: TestCase): void;
    onTestRunEnd(modules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<unknown>, reason: TestRunEndReason): Promise<void>;
    private recordIncludesEveryConfiguredTestFile;
    private notifyReplayReporters;
    private recordModuleFailures;
    private log;
    private error;
    private warn;
}
//# sourceMappingURL=reporter.d.ts.map