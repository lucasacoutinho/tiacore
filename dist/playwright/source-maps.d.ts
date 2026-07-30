export interface PlaywrightCoverageFunction {
    ranges: Array<{
        count: number;
        endOffset: number;
        startOffset: number;
    }>;
}
export declare function coveredSourceMapFiles(scriptUrl: string, suppliedScript: string | undefined, functions: PlaywrightCoverageFunction[], root: string): Promise<string[]>;
export declare function sourceMapFiles(scriptUrl: string, root: string): Promise<string[]>;
//# sourceMappingURL=source-maps.d.ts.map