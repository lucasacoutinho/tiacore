import coverageLibrary from 'istanbul-lib-coverage';
import type { TiaCoverageMap, TiaCoverageRuntime, TiaGraph } from '../shared/types.js';
import { type CoverageThresholdFailure } from './thresholds.js';
export interface CoverageReportResult {
    files: number;
    thresholdFailures: CoverageThresholdFailure[];
    warnings: string[];
}
export declare function portableCoverageMap(root: string, coverage: TiaCoverageMap): TiaCoverageMap;
export declare function mergedGraphCoverage(graph: TiaGraph, root: string): ReturnType<typeof coverageLibrary.createCoverageMap>;
export declare function writeCoverageReports(graph: TiaGraph, root: string, options: TiaCoverageRuntime): CoverageReportResult;
//# sourceMappingURL=report.d.ts.map