import type { CoverageMap } from 'istanbul-lib-coverage';
import type { TiaCoverageThresholds } from '../shared/types.js';
export interface CoverageThresholdFailure {
    message: string;
}
export declare function coverageThresholdFailures(coverageMap: CoverageMap, root: string, thresholds: TiaCoverageThresholds | null): CoverageThresholdFailure[];
//# sourceMappingURL=thresholds.d.ts.map