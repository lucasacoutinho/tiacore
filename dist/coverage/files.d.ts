import coverageLibrary from 'istanbul-lib-coverage';
import type { TiaCoverageRuntime } from '../shared/types.js';
interface SelectedCoverage {
    coverage: ReturnType<typeof coverageLibrary.createCoverageMap>;
    warnings: string[];
}
export declare function selectedCoverage(coverage: ReturnType<typeof coverageLibrary.createCoverageMap>, root: string, options: TiaCoverageRuntime): SelectedCoverage;
export {};
//# sourceMappingURL=files.d.ts.map