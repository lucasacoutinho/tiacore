type Definition = (...arguments_: unknown[]) => void;
type DefinitionFunction = Definition & {
    only: Definition;
    skip: Definition;
    todo: Definition;
};
declare const test: DefinitionFunction;
declare const describe: DefinitionFunction;
declare const noop: () => void;
export { noop as after, noop as afterEach, noop as before, noop as beforeEach, describe, test as it, test as only, test as skip, test, test as todo, describe as suite, };
export declare const assert: {};
export declare const expectFailure: () => void;
export declare const mock: {};
export declare const run: () => AsyncIterable<never>;
export declare const snapshot: {};
export default test;
//# sourceMappingURL=node-discovery-shim.d.ts.map