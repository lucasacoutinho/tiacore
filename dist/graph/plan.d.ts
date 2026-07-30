import type { NormalizedOptions, RunPlan, TiaGraph } from '../shared/types.js';
interface PlanInput {
    cachePrefix: string;
    coverageRequested?: boolean;
    fingerprint: string;
    graph: TiaGraph | null;
    ignoredPrefixes?: string[];
    options: NormalizedOptions;
    root: string;
}
export declare function createRunPlan(input: PlanInput): RunPlan;
export {};
//# sourceMappingURL=plan.d.ts.map