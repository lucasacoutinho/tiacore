import type { TestCase, Vitest } from 'vitest/node';
import type { CachedTestResult } from '../shared/types.js';
export declare const TIA_CACHED_META_KEY = "__tiajs_cached__";
export declare function cachedTestCase(vitest: Vitest, root: string, cached: CachedTestResult): TestCase;
//# sourceMappingURL=cached-test.d.ts.map