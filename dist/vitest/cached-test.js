import { resolve } from 'node:path';
import { TIA_REPLAY_META_KEY, } from '../shared/constants.js';
export const TIA_CACHED_META_KEY = '__tiajs_cached__';
function resultFor(cached) {
    if (cached.state === 'skipped') {
        return {
            errors: undefined,
            note: 'replayed from the tiajs cache',
            state: 'skipped',
        };
    }
    if (cached.state === 'failed') {
        return {
            errors: [
                {
                    message: 'Cached failure',
                    name: 'Error',
                },
            ],
            state: 'failed',
        };
    }
    return {
        errors: undefined,
        state: 'passed',
    };
}
export function cachedTestCase(vitest, root, cached) {
    const project = vitest.getRootProject();
    const result = resultFor(cached);
    const metadata = {
        [TIA_CACHED_META_KEY]: true,
        [TIA_REPLAY_META_KEY]: true,
    };
    let testCase;
    const collection = {
        at: (index) => (index === 0 || index === -1 ? testCase : undefined),
        allTests: function* () {
            yield testCase;
        },
        array: () => [testCase],
        get size() {
            return 1;
        },
        suites: function* () { },
        tests: function* (state) {
            if (state === undefined || state === result.state) {
                yield testCase;
            }
        },
        *[Symbol.iterator]() {
            yield testCase;
        },
    };
    const moduleId = resolve(root, cached.file);
    const module = {
        children: collection,
        diagnostic: () => cached.duration === undefined
            ? undefined
            : {
                duration: cached.duration,
                environmentSetupDuration: 0,
                prepareDuration: 0,
                setupDuration: 0,
            },
        errors: () => [],
        fullName: cached.file,
        id: `tiajs:cached:${cached.file}`,
        location: undefined,
        meta: () => metadata,
        moduleId,
        name: cached.file,
        ok: () => result.state !== 'failed',
        pool: 'cached',
        project,
        state: () => result.state === 'failed'
            ? 'failed'
            : result.state === 'skipped'
                ? 'skipped'
                : 'passed',
        type: 'module',
    };
    testCase = {
        annotations: () => [],
        artifacts: () => [],
        diagnostic: () => cached.duration === undefined
            ? undefined
            : {
                duration: cached.duration,
                flaky: false,
                repeatCount: 0,
                retryCount: 0,
                slow: cached.duration > project.globalConfig.slowTestThreshold,
                startTime: Date.now() - cached.duration,
            },
        fullName: cached.fullName,
        id: cached.id,
        location: undefined,
        meta: () => metadata,
        module,
        name: cached.fullName.split(' > ').at(-1) ?? cached.fullName,
        ok: () => result.state !== 'failed',
        options: {
            concurrent: false,
            fails: false,
            repeats: 0,
            retry: 0,
            shuffle: false,
            skip: cached.state === 'skipped',
            tags: [],
            timeout: 0,
            todo: false,
        },
        parent: module,
        project,
        result: () => result,
        tags: [],
        toTestSpecification: () => project.createSpecification(moduleId, {
            testIds: [cached.id],
        }),
        type: 'test',
    };
    return testCase;
}
//# sourceMappingURL=cached-test.js.map