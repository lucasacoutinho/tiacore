import { availableParallelism } from 'node:os';
export function normalizedConcurrency(value) {
    if (value === undefined) {
        return Math.max(1, Math.min(4, availableParallelism()));
    }
    return Math.max(1, Math.floor(value));
}
export function groupBy(values, key) {
    const groups = new Map();
    for (const value of values) {
        const group = key(value);
        const items = groups.get(group) ?? [];
        items.push(value);
        groups.set(group, items);
    }
    return groups;
}
export async function parallelMap(values, concurrency, worker) {
    const results = new Array(values.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (next < values.length) {
            const index = next;
            next += 1;
            results[index] = await worker(values[index], index);
        }
    }));
    return results;
}
//# sourceMappingURL=parallel.js.map