import type { Baseline } from '../shared/types.js';
export declare function currentSha(root: string): string | null;
export declare function isAncestor(root: string, ancestor: string, descendant: string): boolean;
export declare function changedFilesSince(root: string, baseline: Baseline, ignoredPrefixes: string | string[]): string[] | null;
export declare function captureBaseline(root: string, ignoredPrefixes: string | string[]): Baseline | null;
//# sourceMappingURL=baseline.d.ts.map