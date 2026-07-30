import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const output = process.env.TIAJS_NODE_DISCOVERY_FILE;
const suites = [];
function sourceLocation() {
    const stack = new Error().stack?.split('\n').slice(2) ?? [];
    for (const line of stack) {
        if (line.includes('node-discovery-shim')) {
            continue;
        }
        const match = /\(?((?:file:\/\/\/|[a-z]:[\\/]|\/).+):(\d+):(\d+)\)?$/i.exec(line.trim());
        if (match?.[1] === undefined) {
            continue;
        }
        try {
            return {
                column: Number(match[3] ?? 1),
                file: match[1].startsWith('file:')
                    ? fileURLToPath(match[1])
                    : match[1],
                line: Number(match[2] ?? 1),
            };
        }
        catch {
            continue;
        }
    }
    return null;
}
function definitionArguments(arguments_) {
    const callback = typeof arguments_.at(-1) === 'function'
        ? arguments_.at(-1)
        : null;
    const name = typeof arguments_[0] === 'string'
        ? arguments_[0]
        : callback?.name || '<anonymous>';
    const options = arguments_.find((argument) => typeof argument === 'object' &&
        argument !== null &&
        !Array.isArray(argument));
    return {
        callback,
        name,
        skipped: Boolean(options?.skip || options?.todo),
    };
}
function write(record) {
    if (output !== undefined && output !== '') {
        appendFileSync(output, `${JSON.stringify(record)}\n`);
    }
}
function defineTest(forcedSkipped, arguments_) {
    const definition = definitionArguments(arguments_);
    const location = sourceLocation();
    if (location === null) {
        return;
    }
    write({
        ...location,
        fullName: [...suites.map((suite) => suite.name), definition.name].join(' '),
        name: definition.name,
        skipped: forcedSkipped ||
            definition.skipped ||
            suites.some((suite) => suite.skipped),
    });
}
const test = ((...arguments_) => {
    defineTest(false, arguments_);
});
test.only = test;
test.skip = (...arguments_) => {
    defineTest(true, arguments_);
};
test.todo = test.skip;
function defineSuite(forcedSkipped, arguments_) {
    const definition = definitionArguments(arguments_);
    if (definition.callback === null) {
        return;
    }
    suites.push({
        name: definition.name,
        skipped: forcedSkipped || definition.skipped,
    });
    try {
        definition.callback.call({
            name: definition.name,
            signal: new AbortController().signal,
        });
    }
    finally {
        suites.pop();
    }
}
const describe = ((...arguments_) => {
    defineSuite(false, arguments_);
});
describe.only = describe;
describe.skip = (...arguments_) => {
    defineSuite(true, arguments_);
};
describe.todo = describe.skip;
const noop = () => { };
const noopObject = new Proxy({}, { get: () => noop });
const emptyRun = () => ({
    async *[Symbol.asyncIterator]() { },
});
Object.assign(test, {
    after: noop,
    afterEach: noop,
    before: noop,
    beforeEach: noop,
    describe,
    it: test,
    mock: noopObject,
    suite: describe,
});
export { noop as after, noop as afterEach, noop as before, noop as beforeEach, describe, test as it, test as only, test as skip, test, test as todo, describe as suite, };
export const assert = noopObject;
export const expectFailure = noop;
export const mock = noopObject;
export const run = emptyRun;
export const snapshot = noopObject;
export default test;
//# sourceMappingURL=node-discovery-shim.js.map