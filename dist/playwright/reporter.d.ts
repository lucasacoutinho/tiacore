import type { FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
export default class TiaPlaywrightReporter implements Reporter {
    private configuredTestIds;
    private readonly observations;
    onBegin(_config: unknown, suite: Suite): void;
    onTestEnd(test: TestCase, result: TestResult): void;
    onEnd(result: FullResult): void;
    printsToStdio(): boolean;
}
//# sourceMappingURL=reporter.d.ts.map