import type { TiaArtifactProvider, TiaArtifactSource } from '../shared/types.js';
export interface RestoreArtifactsInput {
    cacheDir: string;
    coverageRequested?: boolean;
    fingerprint: string;
    log: boolean;
    providers: TiaArtifactProvider[];
    root?: string;
    runner?: string;
}
export interface RestoreArtifactResult {
    artifactId?: Array<number | string> | number | string;
    provider?: string;
    reason: string;
    restored: boolean;
}
export declare function artifactProviders(sources: TiaArtifactSource | TiaArtifactSource[] | undefined): TiaArtifactProvider[];
export declare function restoreGraphFromArtifacts(input: RestoreArtifactsInput): Promise<RestoreArtifactResult>;
//# sourceMappingURL=restore.d.ts.map