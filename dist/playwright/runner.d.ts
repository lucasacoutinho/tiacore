import type { TiaArtifactSource, RunPlan } from '../shared/types.js';
export interface TiaPlaywrightOptions {
    artifacts?: TiaArtifactSource | TiaArtifactSource[];
    cacheDir?: string;
    config?: string;
    cwd?: string;
    fresh?: boolean;
    ignoreChanges?: string[];
    log?: boolean;
    name?: string;
    onUnknownChange?: 'full' | 'ignore';
    root?: string;
}
export interface TiaPlaywrightResult {
    plan: RunPlan;
    status: number;
    success: boolean;
}
export declare class TiaPlaywrightRunner {
    private readonly options;
    constructor(options: TiaPlaywrightOptions);
    run(arguments_?: string[]): Promise<TiaPlaywrightResult>;
}
//# sourceMappingURL=runner.d.ts.map