import type { TiaFrameworkEdgeAdapter, TiaFrameworkEdgeContext } from '../shared/types.js';
export interface FrameworkEdgeResult {
    complete: boolean;
    files: string[];
}
export declare function resolveFrameworkEdges(adapters: TiaFrameworkEdgeAdapter[], context: TiaFrameworkEdgeContext): FrameworkEdgeResult;
//# sourceMappingURL=resolve.d.ts.map