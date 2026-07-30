import type { CoverageMapLike, TiaCoverageMap } from '../shared/types.js';
interface CoverageSnapshot {
    b: Record<string, number[]>;
    f: Record<string, number>;
    s: Record<string, number>;
}
export type CoverageSnapshotMap = Record<string, CoverageSnapshot>;
export declare function snapshotCoverage(coverage: CoverageMapLike | undefined): CoverageSnapshotMap;
export declare function executedFilesSince(before: CoverageSnapshotMap, coverage: CoverageMapLike | undefined): string[];
export declare function coverageDelta(before: CoverageSnapshotMap, coverage: CoverageMapLike | undefined): TiaCoverageMap;
export declare function mergeCoverageMaps(...maps: TiaCoverageMap[]): TiaCoverageMap;
export {};
//# sourceMappingURL=runtime.d.ts.map