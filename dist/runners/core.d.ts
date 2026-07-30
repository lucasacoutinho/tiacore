import type { CachedTestResult, NormalizedOptions, RunPlan, TiaGraph, TiaReplayAdapter } from '../shared/types.js';
export interface TiaCoreOptions {
    cacheDir?: string;
    exclude?: string[];
    files: string[];
    fresh?: boolean;
    fingerprint?: string;
    artifacts?: import('../shared/types.js').TiaArtifactSource | import('../shared/types.js').TiaArtifactSource[];
    ignoreChanges?: string[];
    include?: string[];
    log?: boolean;
    onUnknownChange?: 'full' | 'ignore';
    replayAdapters?: TiaReplayAdapter | TiaReplayAdapter[];
    root?: string;
    runner: string;
}
export interface TiaObservation {
    duration?: number;
    file: string;
    files: string[];
    fullName: string;
    id: string;
    state: 'failed' | 'passed' | 'skipped';
}
export declare class TiaCore {
    readonly cacheDir: string;
    readonly options: NormalizedOptions;
    readonly root: string;
    private baselineAtStart;
    private fingerprintAtStart;
    private graphDigestAtStart;
    private planValue;
    private readonly runner;
    private readonly runnerFingerprint;
    private readonly runnerFiles;
    constructor(options: TiaCoreOptions);
    get plan(): RunPlan;
    prepare(): Promise<RunPlan>;
    commit(observations: TiaObservation[], wholeTestFiles: string[]): Promise<TiaGraph | null>;
    replayedResults(): CachedTestResult[];
    private fingerprint;
}
//# sourceMappingURL=core.d.ts.map