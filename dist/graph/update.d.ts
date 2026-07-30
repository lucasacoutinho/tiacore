import type { CachedTestResult, TiaCoverageMap, TiaGraph, TiaTestEdge } from '../shared/types.js';
export interface GraphUpdateInput {
    collectionCoverage?: ReadonlyMap<string, TiaCoverageMap>;
    executedFiles: Iterable<string>;
    fallbackEdges?: ReadonlyMap<string, string[]>;
    fullyExecutedFiles: Iterable<string>;
    previous: TiaGraph | null;
    results: ReadonlyMap<string, CachedTestResult>;
    root: string;
    testCoverage?: ReadonlyMap<string, TiaCoverageMap>;
    testEdges: ReadonlyMap<string, TiaTestEdge>;
}
export declare function emptyGraph(): TiaGraph;
export declare function updateGraph(input: GraphUpdateInput): TiaGraph;
//# sourceMappingURL=update.d.ts.map