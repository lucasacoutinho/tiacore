export declare function normalizedConcurrency(value: number | undefined): number;
export declare function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]>;
export declare function parallelMap<T, R>(values: T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]>;
//# sourceMappingURL=parallel.d.ts.map