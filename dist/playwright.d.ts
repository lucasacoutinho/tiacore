import type { PlaywrightTestArgs, TestType } from '@playwright/test';
import { withTiaFixture } from './playwright/fixture.js';
import { TiaPlaywrightRunner, type TiaPlaywrightOptions, type TiaPlaywrightResult } from './playwright/runner.js';
export type TiaPlaywrightReporter = [string];
export declare function tia(): TiaPlaywrightReporter;
export declare function tia<TestArguments extends PlaywrightTestArgs, WorkerArguments extends object>(test: TestType<TestArguments, WorkerArguments>): ReturnType<typeof withTiaFixture<TestArguments, WorkerArguments>>;
export declare function tia(options: TiaPlaywrightOptions): TiaPlaywrightRunner;
export type { TiaPlaywrightOptions, TiaPlaywrightResult, };
//# sourceMappingURL=playwright.d.ts.map