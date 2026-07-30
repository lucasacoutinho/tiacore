import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, } from 'node:path';
import { GRAPH_SCHEMA_VERSION } from '../shared/constants.js';
export function graphPath(cacheDir) {
    return join(cacheDir, 'graph.json');
}
export function graphDigest(graph) {
    return graph === null
        ? null
        : createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}
export function readGraph(cacheDir) {
    try {
        return parseGraph(readFileSync(graphPath(cacheDir), 'utf8'));
    }
    catch {
        return null;
    }
}
export function parseGraph(source) {
    try {
        const value = typeof source === 'string'
            ? JSON.parse(source)
            : source;
        if (!isGraph(value)) {
            return null;
        }
        if (value.schema === 1 || value.schema === 2) {
            return {
                ...value,
                collectionCoverage: {},
                coverageComplete: false,
                schema: GRAPH_SCHEMA_VERSION,
                testCoverage: {},
                testEdges: value.schema === 1 ? {} : value.testEdges,
            };
        }
        return value;
    }
    catch {
        return null;
    }
}
export function writeGraph(cacheDir, graph) {
    const target = graphPath(cacheDir);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(target), { recursive: true });
    try {
        writeFileSync(temporary, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
        renameSync(temporary, target);
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function lockPath(cacheDir) {
    return join(cacheDir, 'graph.lock');
}
function lockOwner(path) {
    try {
        const value = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
        return (typeof value.createdAt === 'number' &&
            typeof value.hostname === 'string' &&
            typeof value.pid === 'number' &&
            typeof value.token === 'string')
            ? value
            : null;
    }
    catch {
        return null;
    }
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EPERM');
    }
}
function staleLock(path, staleAfter) {
    try {
        const owner = lockOwner(path);
        const age = Date.now() -
            (owner?.createdAt ?? statSync(path).mtimeMs);
        if (owner?.hostname === hostname() && !processAlive(owner.pid)) {
            return true;
        }
        return age >= staleAfter;
    }
    catch {
        return false;
    }
}
async function acquireLock(cacheDir, timeout, staleAfter) {
    const path = lockPath(cacheDir);
    const started = Date.now();
    mkdirSync(cacheDir, { recursive: true });
    while (Date.now() - started < timeout) {
        const owner = {
            createdAt: Date.now(),
            hostname: hostname(),
            pid: process.pid,
            token: randomUUID(),
        };
        try {
            mkdirSync(path);
            writeFileSync(join(path, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8');
            return owner;
        }
        catch (error) {
            if (typeof error !== 'object' ||
                error === null ||
                !('code' in error) ||
                error.code !== 'EEXIST') {
                throw error;
            }
        }
        if (staleLock(path, staleAfter)) {
            rmSync(path, { force: true, recursive: true });
            continue;
        }
        await wait(20 + Math.floor(Math.random() * 30));
    }
    return null;
}
function releaseLock(cacheDir, owner) {
    const path = lockPath(cacheDir);
    if (lockOwner(path)?.token === owner.token) {
        rmSync(path, { force: true, recursive: true });
    }
}
function cleanAbandonedWrites(cacheDir) {
    try {
        for (const entry of readdirSync(cacheDir)) {
            if (/^graph\.json\.\d+\.[\da-f-]{36}\.tmp$/i.test(entry)) {
                rmSync(join(cacheDir, entry), { force: true });
            }
        }
    }
    catch {
        // A missing cache directory or a concurrently removed orphan is benign.
    }
}
function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function sameResult(left, right) {
    if (!isRecord(left) || !isRecord(right)) {
        return same(left, right);
    }
    const { duration: _leftDuration, ...leftValue } = left;
    const { duration: _rightDuration, ...rightValue } = right;
    return same(leftValue, rightValue);
}
function mergeChangedRecord(expected, current, proposed, equivalent = same) {
    const keys = new Set([
        ...Object.keys(expected),
        ...Object.keys(current),
        ...Object.keys(proposed),
    ]);
    for (const key of keys) {
        const before = expected[key];
        const ours = proposed[key];
        const theirs = current[key];
        const oursChanged = !equivalent(ours, before);
        if (!oursChanged) {
            continue;
        }
        const theirsChanged = !equivalent(theirs, before);
        if (theirsChanged && !equivalent(ours, theirs)) {
            return false;
        }
        if (ours === undefined) {
            delete current[key];
        }
        else {
            current[key] = structuredClone(ours);
        }
    }
    return true;
}
function compatibleCommit(left, right) {
    return (left.schema === right.schema &&
        left.fingerprint === right.fingerprint &&
        left.complete === right.complete &&
        left.coverageComplete === right.coverageComplete &&
        same(left.baseline, right.baseline) &&
        same(left.partition, right.partition));
}
function mergeConcurrentGraphs(expected, current, proposed) {
    if (!compatibleCommit(current, proposed)) {
        return null;
    }
    const before = expected ?? {
        collectionCoverage: {},
        edges: {},
        results: {},
        testCoverage: {},
        testEdges: {},
    };
    const merged = structuredClone(current);
    const records = [
        ['collectionCoverage', same],
        ['edges', same],
        ['results', sameResult],
        ['testCoverage', same],
        ['testEdges', same],
    ];
    for (const [key, equivalent] of records) {
        if (!mergeChangedRecord(before[key], merged[key], proposed[key], equivalent)) {
            return null;
        }
    }
    merged.updatedAt =
        proposed.updatedAt > current.updatedAt
            ? proposed.updatedAt
            : current.updatedAt;
    return merged;
}
export async function commitGraph(cacheDir, options) {
    if (graphDigest(options.expected) !== options.expectedDigest) {
        return { graph: readGraph(cacheDir), status: 'conflict' };
    }
    const owner = await acquireLock(cacheDir, options.lockTimeoutMs ?? 10_000, options.staleLockMs ?? 120_000);
    if (owner === null) {
        return { graph: readGraph(cacheDir), status: 'conflict' };
    }
    try {
        cleanAbandonedWrites(cacheDir);
        const current = readGraph(cacheDir);
        if (graphDigest(current) === options.expectedDigest) {
            writeGraph(cacheDir, options.graph);
            return {
                graph: structuredClone(options.graph),
                status: 'committed',
            };
        }
        if (current === null) {
            return { graph: null, status: 'conflict' };
        }
        const merged = mergeConcurrentGraphs(options.expected, current, options.graph);
        if (merged === null) {
            return { graph: current, status: 'conflict' };
        }
        writeGraph(cacheDir, merged);
        return { graph: merged, status: 'merged' };
    }
    finally {
        releaseLock(cacheDir, owner);
    }
}
export function purgeGraph(cacheDir) {
    rmSync(graphPath(cacheDir), { force: true });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isGraph(value) {
    if (!isRecord(value)) {
        return false;
    }
    if ((value.schema !== 1 &&
        value.schema !== 2 &&
        value.schema !== GRAPH_SCHEMA_VERSION) ||
        typeof value.complete !== 'boolean' ||
        typeof value.fingerprint !== 'string' ||
        !isRecord(value.baseline) ||
        typeof value.baseline.sha !== 'string' ||
        (value.baseline.source !== undefined &&
            value.baseline.source !== 'filesystem' &&
            value.baseline.source !== 'git') ||
        !isRecord(value.baseline.workingTree) ||
        !isRecord(value.edges) ||
        !isRecord(value.results) ||
        typeof value.updatedAt !== 'string') {
        return false;
    }
    const workingTree = value.baseline.workingTree;
    const edges = value.edges;
    const results = value.results;
    const testEdges = value.testEdges;
    const collectionCoverage = value.collectionCoverage;
    const testCoverage = value.testCoverage;
    const partition = value.partition;
    return (Object.values(workingTree).every((hash) => typeof hash === 'string') &&
        Object.values(edges).every((files) => Array.isArray(files) &&
            files.every((file) => typeof file === 'string')) &&
        Object.values(results).every((result) => isRecord(result) &&
            typeof result.id === 'string' &&
            typeof result.file === 'string' &&
            typeof result.fullName === 'string' &&
            (result.state === 'passed' ||
                result.state === 'failed' ||
                result.state === 'skipped') &&
            (result.duration === undefined || typeof result.duration === 'number')) &&
        (value.schema === 1 ||
            (isRecord(testEdges) &&
                Object.values(testEdges).every((edge) => isRecord(edge) &&
                    typeof edge.file === 'string' &&
                    Array.isArray(edge.files) &&
                    edge.files.every((file) => typeof file === 'string')))) &&
        (value.schema !== GRAPH_SCHEMA_VERSION ||
            (typeof value.coverageComplete === 'boolean' &&
                isRecord(collectionCoverage) &&
                Object.values(collectionCoverage).every(isRecord) &&
                isRecord(testCoverage) &&
                Object.values(testCoverage).every(isRecord))) &&
        (partition === undefined ||
            (isRecord(partition) &&
                (partition.group === undefined ||
                    typeof partition.group === 'string') &&
                Number.isInteger(partition.index) &&
                Number.isInteger(partition.total) &&
                partition.index >= 1 &&
                partition.total >= partition.index)));
}
//# sourceMappingURL=state.js.map