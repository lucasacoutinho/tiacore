function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function mergeRecord(target, source) {
    for (const [key, value] of Object.entries(source)) {
        const current = target[key];
        if (current !== undefined && !same(current, value)) {
            return false;
        }
        target[key] = structuredClone(value);
    }
    return true;
}
export function mergePartitionedGraphs(fragments) {
    if (fragments.length === 0) {
        return null;
    }
    const first = fragments[0];
    if (first === undefined || first.partition === undefined) {
        return null;
    }
    const total = first.partition.total;
    const group = first.partition.group;
    const baseline = JSON.stringify(first.baseline);
    const fingerprint = first.fingerprint;
    const partitions = new Map();
    for (const fragment of fragments) {
        const partition = fragment.partition;
        if (partition === undefined ||
            partition.total !== total ||
            partition.group !== group ||
            fragment.complete ||
            fragment.fingerprint !== fingerprint ||
            JSON.stringify(fragment.baseline) !== baseline) {
            continue;
        }
        const existing = partitions.get(partition.index);
        if (existing !== undefined && !same(existing, fragment)) {
            return null;
        }
        partitions.set(partition.index, fragment);
    }
    if (partitions.size !== total ||
        [...Array.from({ length: total }, (_, index) => index + 1)].some((index) => !partitions.has(index))) {
        return null;
    }
    const merged = {
        baseline: structuredClone(first.baseline),
        collectionCoverage: {},
        complete: true,
        coverageComplete: true,
        edges: {},
        fingerprint,
        results: {},
        schema: first.schema,
        testCoverage: {},
        testEdges: {},
        updatedAt: '',
    };
    for (const fragment of [...partitions.values()].sort((left, right) => left.partition.index - right.partition.index)) {
        if (!mergeRecord(merged.edges, fragment.edges) ||
            !mergeRecord(merged.results, fragment.results) ||
            !mergeRecord(merged.testEdges, fragment.testEdges) ||
            !mergeRecord(merged.collectionCoverage, fragment.collectionCoverage) ||
            !mergeRecord(merged.testCoverage, fragment.testCoverage)) {
            return null;
        }
        merged.coverageComplete &&= fragment.coverageComplete;
        if (fragment.updatedAt > merged.updatedAt) {
            merged.updatedAt = fragment.updatedAt;
        }
    }
    return merged;
}
//# sourceMappingURL=merge.js.map