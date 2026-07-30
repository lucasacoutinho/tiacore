import type { NormalizedOptions } from '../shared/types.js';
export declare const DELETED_HASH = "<deleted>";
export declare function hashBytes(value: string | Buffer): string;
export declare function hashFile(path: string): string;
export declare function projectFingerprint(root: string, options: NormalizedOptions, extraFiles?: string[]): string;
//# sourceMappingURL=fingerprint.d.ts.map