import type { TiaGraph } from '../shared/types.js';
export declare function graphPath(cacheDir: string): string;
export declare function graphDigest(graph: TiaGraph | null): string | null;
export declare function readGraph(cacheDir: string): TiaGraph | null;
export declare function parseGraph(source: string | unknown): TiaGraph | null;
export declare function writeGraph(cacheDir: string, graph: TiaGraph): void;
export interface GraphCommitResult {
    graph: TiaGraph | null;
    status: 'committed' | 'conflict' | 'merged';
}
export interface GraphCommitOptions {
    expected: TiaGraph | null;
    expectedDigest: string | null;
    graph: TiaGraph;
    lockTimeoutMs?: number;
    staleLockMs?: number;
}
export declare function commitGraph(cacheDir: string, options: GraphCommitOptions): Promise<GraphCommitResult>;
export declare function purgeGraph(cacheDir: string): void;
//# sourceMappingURL=state.d.ts.map