import type { Baseline, TiaGraph, TiaGraphPartition } from '../shared/types.js';
export declare function partitionGroup(baseline: Baseline | null, fingerprint: string, total: number, requested?: string): string;
export declare function partitionCacheDir(cacheDir: string, partition: TiaGraphPartition): string;
export declare function aggregateLocalPartitions(cacheDir: string, partition: TiaGraphPartition): Promise<TiaGraph | null>;
//# sourceMappingURL=partitions.d.ts.map